import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { bootKernel, formPost, multipartPost, ORIGIN, redirectOf, signIn, tempDir } from './helpers'

const bytes = (value: string) => new TextEncoder().encode(value)
const jpeg = async () =>
  new Uint8Array(
    await sharp({ create: { width: 64, height: 48, channels: 3, background: '#2271b1' } })
      .jpeg()
      .toBuffer(),
  )
const get = (key: string, headers: Record<string, string> = {}, method = 'GET') =>
  new Request(new URL(`/uploads/${key}`, ORIGIN), { method, headers })

describe('serving uploads', () => {
  it('sends the file with its type, caching headers, and nothing that could run', async () => {
    const kernel = await bootKernel({ plugins: [] })
    const item = await kernel.media.upload({ name: 'notes.txt', data: bytes('hello world') })
    const response = await kernel.serveUpload(get(item.file), item.file)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('hello world')
    expect(Object.fromEntries(response.headers)).toMatchObject({
      'content-type': 'text/plain; charset=utf-8',
      'content-length': '11',
      'cache-control': 'public, max-age=86400',
      'accept-ranges': 'bytes',
      'x-content-type-options': 'nosniff',
      'content-disposition': 'inline',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    })
    const etag = response.headers.get('etag')!
    const again = await kernel.serveUpload(get(item.file, { 'if-none-match': etag }), item.file)
    expect(again.status).toBe(304)
    const since = response.headers.get('last-modified')!
    const unchanged = await kernel.serveUpload(
      get(item.file, { 'if-modified-since': since }),
      item.file,
    )
    expect(unchanged.status).toBe(304)
  })

  it('sends byte ranges, as video players ask for them', async () => {
    const kernel = await bootKernel({ plugins: [] })
    const item = await kernel.media.upload({ name: 'notes.txt', data: bytes('0123456789') })
    const partial = await kernel.serveUpload(get(item.file, { range: 'bytes=2-5' }), item.file)
    expect(partial.status).toBe(206)
    expect(partial.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(await partial.text()).toBe('2345')
    const tail = await kernel.serveUpload(get(item.file, { range: 'bytes=-3' }), item.file)
    expect(await tail.text()).toBe('789')
    const beyond = await kernel.serveUpload(get(item.file, { range: 'bytes=20-' }), item.file)
    expect(beyond.status).toBe(416)
    expect(beyond.headers.get('content-range')).toBe('bytes */10')
    // A range of a file that changed since would mix two versions: it comes whole.
    const stale = await kernel.serveUpload(
      get(item.file, { range: 'bytes=2-5', 'if-range': '"old"' }),
      item.file,
    )
    expect(stale.status).toBe(200)
    const head = await kernel.serveUpload(get(item.file, {}, 'HEAD'), item.file)
    expect([head.status, head.headers.get('content-length'), await head.text()]).toEqual([
      200,
      '10',
      '',
    ])
  })

  it('lets PDFs show in the browser’s viewer, and downloads archives', async () => {
    const kernel = await bootKernel({ plugins: [] })
    const pdf = await kernel.media.upload({ name: 'a.pdf', data: bytes('%PDF-1.7') })
    const zip = await kernel.media.upload({
      name: 'a.zip',
      data: new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]),
    })
    const pdfResponse = await kernel.serveUpload(get(pdf.file), pdf.file)
    expect(pdfResponse.headers.get('content-security-policy')).toBeNull()
    expect(pdfResponse.headers.get('content-disposition')).toBe('inline')
    const zipResponse = await kernel.serveUpload(get(zip.file), zip.file)
    expect(zipResponse.headers.get('content-disposition')).toBe('attachment')
  })

  it('finds nothing outside the uploads, or that isn’t there', async () => {
    const kernel = await bootKernel({ plugins: [] })
    for (const key of ['../package.json', '2026/../../x', '.env', 'missing.jpg', '2026']) {
      expect((await kernel.serveUpload(get('x'), key)).status).toBe(404)
    }
  })
})

describe('who may use the media library', () => {
  it('is authors and up, as upload_files is in WordPress, each with their own files', async () => {
    const kernel = await bootKernel({ plugins: [] })
    const admin = await signIn(kernel, 'administrator')
    const editor = await signIn(kernel, 'editor')
    const author = await signIn(kernel, 'author')
    const other = await signIn(kernel, 'author')
    const contributor = await signIn(kernel, 'contributor')
    const mine = await kernel.media.upload(
      { name: 'a.txt', data: bytes('a') },
      { by: author.user.id },
    )
    const resolve = (path: string, user: typeof admin.user) =>
      kernel.resolveAdminPage(path, {}, user).then((r) => r.kind)
    expect(await resolve('/admin/media', author.user)).toBe('media-library')
    expect(await resolve('/admin/media/new', author.user)).toBe('media-new')
    expect(await resolve('/admin/media', contributor.user)).toBe('forbidden')
    expect(await resolve(`/admin/media/${mine.id}`, author.user)).toBe('media-edit')
    expect(await resolve(`/admin/media/${mine.id}`, other.user)).toBe('forbidden')
    expect(await resolve(`/admin/media/${mine.id}`, editor.user)).toBe('media-edit')
    expect(await resolve('/admin/media/00000000-0000-0000-0000-000000000000', admin.user)).toBe(
      'not-found',
    )
    expect(kernel.can(other.user, 'core.delete_media', mine)).toBe(false)
    expect(kernel.can(editor.user, 'core.delete_media', mine)).toBe(true)

    const menu = (user: typeof admin.user) =>
      kernel
        .adminMenu(user)
        .map((section) => section.id)
        .join(' ')
    expect(menu(author.user)).toBe('dashboard posts media')
    expect(menu(contributor.user)).toBe('dashboard posts')
  })
})

describe('Media › Add New, Edit Media and Delete Permanently', () => {
  it('upload files from the form, keeping those that pass', async () => {
    const kernel = await bootKernel({ plugins: [] })
    const { user, cookie } = await signIn(kernel, 'author')
    const upload = (files: Parameters<typeof multipartPost>[2]) =>
      multipartPost(kernel.actionUrl('core', 'upload-media'), {}, files, {
        cookie,
        referer: `${ORIGIN}/admin/media/new`,
      }).then((request) => kernel.handleApi(request))

    const one = redirectOf(
      kernel,
      await upload([{ field: 'files', name: 'a.jpg', data: await jpeg() }]),
    )
    const [item] = (await kernel.media.list()).items
    expect(one).toMatchObject({ path: `/admin/media/${item!.id}` })
    expect(one.flash?.message).toBe('Uploaded “a.jpg”.')
    expect(item!.authorId).toBe(user.id)

    const two = redirectOf(
      kernel,
      await upload([
        { field: 'files', name: 'b.txt', data: bytes('b') },
        { field: 'files', name: 'c.txt', data: bytes('c') },
        { field: 'files', name: 'd.exe', data: bytes('MZ') },
      ]),
    )
    expect(two.path).toBe('/admin/media')
    expect(two.flash?.message).toBe(
      "Uploaded 2 files. “d.exe” wasn't uploaded: This file type isn't allowed.",
    )

    const none = redirectOf(
      kernel,
      await upload([{ field: 'files', name: 'e.exe', data: bytes('MZ') }]),
    )
    expect(none).toMatchObject({ path: '/admin/media/new' })
    expect(none.flash).toMatchObject({ kind: 'error' })
  })

  it('refuse a form over the limit before reading it', async () => {
    const kernel = await bootKernel({ plugins: [], uploads: { dir: tempDir(), maxBytes: 1024 } })
    const { cookie } = await signIn(kernel, 'author')
    const request = await multipartPost(
      kernel.actionUrl('core', 'upload-media'),
      {},
      [{ field: 'files', name: 'big.txt', data: new Uint8Array(200_000).fill(65) }],
      { cookie, referer: `${ORIGIN}/admin/media/new` },
    )
    const done = redirectOf(kernel, await kernel.handleApi(request))
    expect(done.flash?.message).toBe(
      'The files are larger than the 1 KB limit together. Upload fewer at a time.',
    )
    expect((await kernel.media.list()).total).toBe(0)
  })

  it('change details and delete, only for those who may', async () => {
    const kernel = await bootKernel({ plugins: [] })
    const author = await signIn(kernel, 'author')
    const other = await signIn(kernel, 'author')
    const editor = await signIn(kernel, 'editor')
    const item = await kernel.media.upload(
      { name: 'a.txt', data: bytes('a') },
      { by: author.user.id },
    )
    const save = (cookie: string) =>
      kernel.handleApi(
        formPost(
          kernel.actionUrl('core', 'save-media'),
          { id: item.id, title: 'Renamed', alt: '', caption: 'Hi', description: '' },
          { cookie },
        ),
      )
    expect((await save(other.cookie)).status).toBe(403)
    const saved = redirectOf(kernel, await save(author.cookie))
    expect(saved).toMatchObject({ path: `/admin/media/${item.id}` })
    expect(saved.flash?.message).toBe('Media file updated.')
    expect(await kernel.media.get(item.id)).toMatchObject({ title: 'Renamed', caption: 'Hi' })

    const second = await kernel.media.upload(
      { name: 'b.txt', data: bytes('b') },
      { by: author.user.id },
    )
    const third = await kernel.media.upload(
      { name: 'c.txt', data: bytes('c') },
      { by: author.user.id },
    )
    const remove = (cookie: string, fields: Record<string, string | string[]>) =>
      kernel.handleApi(formPost(kernel.actionUrl('core', 'delete-media'), fields, { cookie }))
    const both = { bulk: 'delete', ids: [item.id, second.id] }
    expect((await remove(other.cookie, both)).status).toBe(403)
    expect((await kernel.media.list()).total).toBe(3)
    // Apply with no bulk action chosen deletes nothing.
    const unchosen = redirectOf(kernel, await remove(editor.cookie, { bulk: '', ids: both.ids }))
    expect(unchosen.flash).toMatchObject({ kind: 'error', message: 'Choose a bulk action.' })
    const deleted = redirectOf(kernel, await remove(editor.cookie, both))
    expect(deleted.flash?.message).toBe('2 media files permanently deleted.')
    // A row's button names its file, whatever else is checked.
    const row = redirectOf(kernel, await remove(author.cookie, { id: third.id, ids: [item.id] }))
    expect(row.flash?.message).toBe('Media file permanently deleted.')
    expect((await kernel.media.list()).total).toBe(0)
  })
})

describe('the upload API', () => {
  it('takes one file from the drag-and-drop uploader and answers with it', async () => {
    const kernel = await bootKernel({ plugins: [] })
    const { cookie } = await signIn(kernel, 'author')
    const post = await kernel.content.create('core.post', { title: 'Hi' })
    const request = await multipartPost(
      '/api/p/core/media',
      { entry: post.id },
      [{ field: 'file', name: 'Photo.jpg', data: await jpeg() }],
      { cookie },
    )
    const response = await kernel.handleApi(request)
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      filename: 'Photo.jpg',
      kind: 'image',
      entryId: post.id,
      sizes: {},
    })
  })

  it('refuses the signed out, those who may not upload, big files and wrong types', async () => {
    const kernel = await bootKernel({ plugins: [], uploads: { dir: tempDir(), maxBytes: 1024 } })
    const contributor = await signIn(kernel, 'contributor')
    const author = await signIn(kernel, 'author')
    const send = async (cookie: string | null, name: string, data: Uint8Array) => {
      const request = await multipartPost(
        '/api/p/core/media',
        {},
        [{ field: 'file', name, data }],
        cookie ? { cookie } : {},
      )
      const response = await kernel.handleApi(request)
      return [response.status, ((await response.json()) as { error: string }).error]
    }
    expect(await send(null, 'a.txt', bytes('a'))).toEqual([401, 'Sign in to upload files.'])
    expect(await send(contributor.cookie, 'a.txt', bytes('a'))).toEqual([
      403,
      'You are not allowed to upload files.',
    ])
    expect(await send(author.cookie, 'big.txt', new Uint8Array(100_000).fill(65))).toEqual([
      413,
      'The file is larger than the 1 KB limit.',
    ])
    expect(await send(author.cookie, 'a.exe', bytes('MZ'))).toEqual([
      415,
      "This file type isn't allowed.",
    ])
  })
})

describe('the media picker’s list', () => {
  it('pages the library for those who may upload, by kind and search', async () => {
    const kernel = await bootKernel({ plugins: [] })
    const author = await signIn(kernel, 'author')
    const contributor = await signIn(kernel, 'contributor')
    await kernel.media.upload({ name: 'Boat.jpg', data: await jpeg() })
    await kernel.media.upload({ name: 'Boat notes.txt', data: bytes('a') })
    const list = (query: string, cookie?: string) =>
      kernel.handleApi(
        new Request(new URL(`/api/p/core/media${query}`, ORIGIN), {
          headers: cookie ? { cookie } : {},
        }),
      )
    const response = await list('?kind=image&search=boat', author.cookie)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = (await response.json()) as { items: { filename: string }[]; total: number }
    expect(body).toMatchObject({ total: 1, pages: 1, items: [{ filename: 'Boat.jpg' }] })
    expect((await list('?page=0', author.cookie)).status).toBe(400)
    expect((await list('', contributor.cookie)).status).toBe(403)
    expect((await list('')).status).toBe(401)
  })
})
