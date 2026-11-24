import type { MediaItem, MediaStorage } from '@otwdesign/sdk'
import { sql } from 'drizzle-orm'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import type { Kernel } from '../src/kernel'
import { localStorage } from '../src/media-storage'
import { MAX_PENDING_UPLOADS } from '../src/media-uploads'
import { bootKernel, ORIGIN, plugin, signIn, tempDir } from './helpers'

const bytes = (value: string) => new TextEncoder().encode(value)
const jpeg = async (width = 64, height = 48) =>
  new Uint8Array(
    await sharp({ create: { width, height, channels: 3, background: '#2271b1' } })
      .jpeg()
      .toBuffer(),
  )

/** A storage browsers can upload to: the test sends "the browser's" bytes with `put()`. */
function directStorage(minBytes = 0) {
  const disk = localStorage(tempDir())
  const signed: { key: string; size: number; expiresAt: Date }[] = []
  const deleted: string[] = []
  const storage: MediaStorage = {
    ...disk,
    async delete(key) {
      deleted.push(key)
      return disk.delete(key)
    },
    directUploads: {
      minBytes,
      async target(key, { size, expiresAt }) {
        signed.push({ key, size, expiresAt })
        return {
          url: `https://storage.test/${key}?signature=abc`,
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream' },
        }
      },
    },
  }
  return {
    storage,
    signed,
    deleted,
    put: (key: string, data: Uint8Array) => disk.create(key, data, 'application/octet-stream'),
    has: async (key: string) => (await disk.stat(key)) !== null,
  }
}

async function boot(store = directStorage(), maxBytes?: number) {
  const kernel = await bootKernel({
    plugins: [
      plugin('bucket', {
        setup(cms) {
          cms.media.storage(store.storage)
        },
      }),
    ],
    ...(maxBytes ? { uploads: { dir: tempDir(), maxBytes } } : {}),
  })
  return { kernel, store }
}

const api = (
  kernel: Kernel,
  method: string,
  path: string,
  cookie: string | null,
  body?: unknown,
  headers: Record<string, string> = {},
) =>
  kernel.handleApi(
    new Request(new URL(`/api/p/core/media/uploads${path}`, ORIGIN), {
      method,
      headers: {
        origin: ORIGIN,
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    }),
  )

interface Begun {
  id: string
  url: string
  method: string
  headers: Record<string, string>
  expiresAt: string
}

async function begin(kernel: Kernel, cookie: string, name: string, size: number, entry?: string) {
  const response = await api(kernel, 'POST', '', cookie, {
    name,
    size,
    ...(entry ? { entry } : {}),
  })
  expect(response.status).toBe(201)
  return (await response.json()) as Begun
}

/** A raw query's rows: the test database answers `{ rows }`. */
const rows = async <T>(kernel: Kernel, query: Parameters<Kernel['db']['execute']>[0]) =>
  ((await kernel.db.execute(query)) as unknown as { rows: T[] }).rows

const pendingRows = (kernel: Kernel) =>
  rows<{ id: string; key: string; media_id: string | null }>(
    kernel,
    sql`SELECT id, key, media_id FROM cms_media_uploads ORDER BY created_at`,
  )

describe('a site whose uploads go through it', () => {
  it('offers no direct uploads, and lets a plugin read the disk’s files', async () => {
    let disk: Pick<MediaStorage, 'read' | 'stat'> | undefined
    const kernel = await bootKernel({
      plugins: [
        plugin('copier', {
          setup(cms) {
            disk = cms.media.disk
          },
        }),
      ],
    })
    expect(kernel.directUploads).toBeNull()
    const { cookie } = await signIn(kernel, 'author')
    const response = await api(kernel, 'POST', '', cookie, { name: 'a.txt', size: 1 })
    expect(response.status).toBe(404)
    expect(await pendingRows(kernel)).toEqual([])

    const item = await kernel.media.upload({ name: 'notes.txt', data: bytes('on disk') })
    expect(await disk!.stat(item.file)).toMatchObject({ size: 7 })
    const file = await disk!.read(item.file)
    expect(await new Response(file!.body).text()).toBe('on disk')
    expect(disk).not.toHaveProperty('create')
    expect(disk).not.toHaveProperty('delete')
  })

  it('refuses a storage whose direct uploads make no sense', async () => {
    const broken = (directUploads: unknown) =>
      bootKernel({
        plugins: [
          plugin('bucket', {
            setup(cms) {
              cms.media.storage({ ...localStorage(tempDir()), directUploads } as MediaStorage)
            },
          }),
        ],
      })
    await expect(broken({ minBytes: 0 })).rejects.toThrow('directUploads needs target()')
    await expect(broken({ minBytes: -1, target: async () => ({}) })).rejects.toThrow(
      'directUploads needs target()',
    )
    await expect(broken(null)).rejects.toThrow('directUploads needs target()')
  })
})

describe('beginning a direct upload', () => {
  it('signs an address for one temporary key, for the size announced', async () => {
    const { kernel, store } = await boot(directStorage(4096))
    expect(kernel.directUploads).toEqual({ minBytes: 4096 })
    const { cookie } = await signIn(kernel, 'author')
    const before = Date.now()
    const begun = await begin(kernel, cookie, 'Holiday Photo.jpg', 5000)

    expect(begun.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(begun).toMatchObject({
      url: `https://storage.test/_uploads/${begun.id}?signature=abc`,
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
    })
    expect(store.signed).toHaveLength(1)
    expect(store.signed[0]).toMatchObject({ key: `_uploads/${begun.id}`, size: 5000 })
    // The address takes the file for a quarter of an hour.
    const minutes = (store.signed[0]!.expiresAt.getTime() - before) / 60_000
    expect(minutes).toBeGreaterThan(14.9)
    expect(minutes).toBeLessThan(15.1)
    expect(new Date(begun.expiresAt).getTime()).toBe(store.signed[0]!.expiresAt.getTime())
    expect(await pendingRows(kernel)).toEqual([
      { id: begun.id, key: `_uploads/${begun.id}`, media_id: null },
    ])
    // It's swept when it runs out, by a job queued for then.
    expect(await kernel.jobs.next('core.media_uploads_sweep')).toBeInstanceOf(Date)
  })

  it('refuses the signed out, those who may not upload, and requests that aren’t JSON', async () => {
    const { kernel, store } = await boot()
    const contributor = await signIn(kernel, 'contributor')
    const author = await signIn(kernel, 'author')
    const body = { name: 'a.txt', size: 3 }
    expect((await api(kernel, 'POST', '', null, body)).status).toBe(401)
    expect((await api(kernel, 'POST', '', contributor.cookie, body)).status).toBe(403)
    // Another site's page can't begin one as the person signed in here.
    const foreign = await api(kernel, 'POST', '', author.cookie, body, {
      origin: 'https://evil.example',
    })
    expect(foreign.status).toBe(403)
    const form = await api(kernel, 'POST', '', author.cookie, 'name=a.txt', {
      'content-type': 'application/x-www-form-urlencoded',
    })
    expect(form.status).toBe(415)
    expect((await api(kernel, 'POST', '', author.cookie, 'not json')).status).toBe(400)
    expect((await api(kernel, 'POST', '', author.cookie, '[]')).status).toBe(400)
    const long = await api(kernel, 'POST', '', author.cookie, { name: 'a'.repeat(5000), size: 3 })
    expect(long.status).toBe(413)
    expect(store.signed).toEqual([])
    expect(await pendingRows(kernel)).toEqual([])
  })

  it('refuses a file that could never be stored, before any byte is sent', async () => {
    const { kernel, store } = await boot(directStorage(), 1024)
    const { cookie } = await signIn(kernel, 'author')
    const refused = async (body: unknown) => {
      const response = await api(kernel, 'POST', '', cookie, body)
      return [response.status, ((await response.json()) as { error: string }).error]
    }
    expect(await refused({ name: 'big.txt', size: 1025 })).toEqual([
      413,
      'The file is larger than the 1 KB limit.',
    ])
    expect(await refused({ name: 'run.exe', size: 10 })).toEqual([
      415,
      "This file type isn't allowed.",
    ])
    expect(await refused({ name: 'no-extension', size: 10 })).toEqual([
      415,
      "This file type isn't allowed.",
    ])
    for (const size of [0, -1, 1.5, '10', null]) {
      expect((await refused({ name: 'a.txt', size }))[0]).toBe(400)
    }
    for (const name of ['', '   ', 7, 'a'.repeat(256) + '.txt']) {
      expect((await refused({ name, size: 10 }))[0]).toBe(400)
    }
    expect((await refused({ name: 'a.txt', size: 10, entry: 'not-an-id' }))[0]).toBe(400)
    expect(store.signed).toEqual([])
    expect(await pendingRows(kernel)).toEqual([])
  })

  it('lets one account have only so many under way', async () => {
    const { kernel } = await boot()
    const greedy = await signIn(kernel, 'author')
    const other = await signIn(kernel, 'author')
    for (let count = 0; count < MAX_PENDING_UPLOADS; count++) {
      await begin(kernel, greedy.cookie, `file-${count}.txt`, 10)
    }
    const response = await api(kernel, 'POST', '', greedy.cookie, { name: 'more.txt', size: 10 })
    expect(response.status).toBe(429)
    // The limit is each account's own.
    await begin(kernel, other.cookie, 'mine.txt', 10)
  })

  it('leaves nothing behind when the storage can’t sign, or signs nonsense', async () => {
    const store = directStorage()
    let answer: () => Promise<unknown> = async () => {
      throw new Error('The bucket is unreachable')
    }
    store.storage.directUploads!.target = (() => answer()) as never
    const { kernel } = await boot(store)
    const { cookie } = await signIn(kernel, 'author')
    const body = { name: 'a.txt', size: 3 }
    expect((await api(kernel, 'POST', '', cookie, body)).status).toBe(500)
    for (const target of [
      { url: 'javascript:alert(1)', method: 'PUT', headers: {} },
      { url: 'https://storage.test/x', method: 'POST', headers: {} },
      { url: 'https://storage.test/x', method: 'PUT', headers: { a: 1 } },
      null,
    ]) {
      answer = async () => target
      expect((await api(kernel, 'POST', '', cookie, body)).status).toBe(500)
    }
    expect(await pendingRows(kernel)).toEqual([])
  })
})

describe('finishing a direct upload', () => {
  it('stores the file as any upload, sizes and all, and deletes the one that waited', async () => {
    const { kernel, store } = await boot()
    const { user, cookie } = await signIn(kernel, 'author')
    const post = await kernel.content.create('core.post', { title: 'Hi' })
    const data = await jpeg(800, 600)
    const begun = await begin(kernel, cookie, 'Holiday Photo.JPG', data.byteLength, post.id)
    const waiting = `_uploads/${begun.id}`
    await store.put(waiting, data)
    // A file waiting to be checked is never served, whatever it holds.
    const peek = await kernel.serveUpload(
      new Request(new URL(`/uploads/${waiting}`, ORIGIN)),
      waiting,
    )
    expect(peek.status).toBe(404)

    const response = await api(kernel, 'POST', `/${begun.id}/complete`, cookie)
    expect(response.status).toBe(201)
    const item = (await response.json()) as MediaItem
    expect(item).toMatchObject({
      filename: 'Holiday Photo.JPG',
      mimeType: 'image/jpeg',
      kind: 'image',
      width: 800,
      height: 600,
      authorId: user.id,
      entryId: post.id,
      size: data.byteLength,
    })
    expect(item.file).toMatch(/\/holiday-photo\.jpg$/)
    expect(Object.keys(item.sizes)).toEqual(expect.arrayContaining(['thumbnail', 'medium']))
    expect(await store.has(item.file)).toBe(true)
    expect(await store.has(item.sizes.thumbnail!.file)).toBe(true)
    expect(await store.has(waiting)).toBe(false)
    expect(await pendingRows(kernel)).toEqual([{ id: begun.id, key: waiting, media_id: item.id }])

    // Asked again, after a lost answer say: the same item, and no second file.
    const again = await api(kernel, 'POST', `/${begun.id}/complete`, cookie)
    expect(again.status).toBe(200)
    expect(((await again.json()) as MediaItem).id).toBe(item.id)
    expect((await kernel.media.list()).total).toBe(1)
  })

  it('stores it once when two requests finish it together', async () => {
    const { kernel, store } = await boot()
    const { cookie } = await signIn(kernel, 'author')
    const data = bytes('only once')
    const begun = await begin(kernel, cookie, 'notes.txt', data.byteLength)
    await store.put(`_uploads/${begun.id}`, data)
    const statuses = (
      await Promise.all([
        api(kernel, 'POST', `/${begun.id}/complete`, cookie),
        api(kernel, 'POST', `/${begun.id}/complete`, cookie),
      ])
    )
      .map((response) => response.status)
      .sort()
    // The second finds it being stored (409), or stored already (200).
    expect([
      [201, 409],
      [200, 201],
    ]).toContainEqual(statuses)
    expect((await kernel.media.list()).total).toBe(1)
  })

  it('waits for a file that hasn’t arrived, and takes it when it has', async () => {
    const { kernel, store } = await boot()
    const { cookie } = await signIn(kernel, 'author')
    const data = bytes('late')
    const begun = await begin(kernel, cookie, 'late.txt', data.byteLength)
    const early = await api(kernel, 'POST', `/${begun.id}/complete`, cookie)
    expect(early.status).toBe(409)
    expect(await early.json()).toEqual({ error: 'The file hasn’t reached storage. Send it again.' })
    await store.put(`_uploads/${begun.id}`, data)
    expect((await api(kernel, 'POST', `/${begun.id}/complete`, cookie)).status).toBe(201)
  })

  it('refuses a file that isn’t what was announced, and keeps nothing of it', async () => {
    const { kernel, store } = await boot()
    const { cookie } = await signIn(kernel, 'author')
    const refused = async (name: string, announced: number, sent: Uint8Array) => {
      const begun = await begin(kernel, cookie, name, announced)
      await store.put(`_uploads/${begun.id}`, sent)
      const response = await api(kernel, 'POST', `/${begun.id}/complete`, cookie)
      expect(await store.has(`_uploads/${begun.id}`)).toBe(false)
      // Gone for good: asking again finds nothing.
      expect((await api(kernel, 'POST', `/${begun.id}/complete`, cookie)).status).toBe(404)
      return [response.status, ((await response.json()) as { error: string }).error]
    }
    expect(await refused('notes.txt', 4, bytes('longer than four'))).toEqual([
      400,
      'The file that arrived isn’t the size that was announced.',
    ])
    // Its type is found from its bytes, as for any upload: a page named as a picture is refused.
    const page = bytes('<script>alert(1)</script>')
    expect(await refused('photo.jpg', page.byteLength, page)).toEqual([
      415,
      "The file isn't a valid JPG image.",
    ])
    expect(await pendingRows(kernel)).toEqual([])
    expect((await kernel.media.list()).total).toBe(0)
  })

  it('is each account’s own, and stops when it has run out', async () => {
    const { kernel, store } = await boot()
    const mine = await signIn(kernel, 'author')
    const theirs = await signIn(kernel, 'administrator')
    const data = bytes('mine')
    const begun = await begin(kernel, mine.cookie, 'mine.txt', data.byteLength)
    await store.put(`_uploads/${begun.id}`, data)

    expect((await api(kernel, 'POST', `/${begun.id}/complete`, theirs.cookie)).status).toBe(404)
    expect((await api(kernel, 'POST', `/${begun.id}/complete`, null)).status).toBe(401)
    expect((await api(kernel, 'POST', '/not-an-id/complete', mine.cookie)).status).toBe(404)
    expect((await api(kernel, 'DELETE', `/${begun.id}`, theirs.cookie)).status).toBe(204)
    expect(await pendingRows(kernel)).toHaveLength(1)

    await kernel.db.execute(
      sql`UPDATE cms_media_uploads SET expires_at = now() - interval '1 second'`,
    )
    const late = await api(kernel, 'POST', `/${begun.id}/complete`, mine.cookie)
    expect(late.status).toBe(410)
    expect((await kernel.media.list()).total).toBe(0)
  })

  it('lets a passing storage problem be tried again', async () => {
    const store = directStorage()
    const { kernel } = await boot(store)
    const { cookie } = await signIn(kernel, 'author')
    const data = bytes('second time lucky')
    const begun = await begin(kernel, cookie, 'notes.txt', data.byteLength)
    await store.put(`_uploads/${begun.id}`, data)
    const create = store.storage.create
    store.storage.create = async () => {
      throw new Error('The bucket is unreachable')
    }
    expect((await api(kernel, 'POST', `/${begun.id}/complete`, cookie)).status).toBe(500)
    expect(await store.has(`_uploads/${begun.id}`)).toBe(true)
    store.storage.create = create
    expect((await api(kernel, 'POST', `/${begun.id}/complete`, cookie)).status).toBe(201)
  })
})

describe('giving a direct upload up', () => {
  it('deletes what reached storage, and only the account’s own', async () => {
    const { kernel, store } = await boot()
    const { cookie } = await signIn(kernel, 'author')
    const begun = await begin(kernel, cookie, 'notes.txt', 4)
    await store.put(`_uploads/${begun.id}`, bytes('half'))
    expect((await api(kernel, 'DELETE', `/${begun.id}`, null)).status).toBe(401)
    expect((await api(kernel, 'DELETE', `/${begun.id}`, cookie)).status).toBe(204)
    expect(await store.has(`_uploads/${begun.id}`)).toBe(false)
    expect(await pendingRows(kernel)).toEqual([])
    // Twice, or for one that never was, is no error.
    expect((await api(kernel, 'DELETE', `/${begun.id}`, cookie)).status).toBe(204)
    expect((await api(kernel, 'DELETE', '/nonsense', cookie)).status).toBe(204)
  })

  it('never takes a finished upload’s item with it', async () => {
    const { kernel, store } = await boot()
    const { cookie } = await signIn(kernel, 'author')
    const data = bytes('kept')
    const begun = await begin(kernel, cookie, 'kept.txt', data.byteLength)
    await store.put(`_uploads/${begun.id}`, data)
    expect((await api(kernel, 'POST', `/${begun.id}/complete`, cookie)).status).toBe(201)
    expect((await api(kernel, 'DELETE', `/${begun.id}`, cookie)).status).toBe(204)
    expect((await kernel.media.list()).total).toBe(1)
    expect(await pendingRows(kernel)).toHaveLength(1)
  })
})

describe('uploads never finished', () => {
  it('are swept when they run out, with their files, and the sweep stops when none is left', async () => {
    const { kernel, store } = await boot()
    const { cookie } = await signIn(kernel, 'author')
    const stale = await begin(kernel, cookie, 'stale.txt', 5)
    const fresh = await begin(kernel, cookie, 'fresh.txt', 5)
    await store.put(`_uploads/${stale.id}`, bytes('stale'))
    await store.put(`_uploads/${fresh.id}`, bytes('fresh'))
    await kernel.db.execute(
      sql`UPDATE cms_media_uploads SET expires_at = now() - interval '1 minute' WHERE id = ${stale.id}`,
    )
    const due = () =>
      kernel.db.execute(
        sql`UPDATE cms_jobs SET run_at = now() WHERE name = 'core.media_uploads_sweep' AND status = 'pending'`,
      )

    await due()
    expect((await kernel.jobs.runDue()).ran).toBe(1)
    expect(await store.has(`_uploads/${stale.id}`)).toBe(false)
    expect(await store.has(`_uploads/${fresh.id}`)).toBe(true)
    expect((await pendingRows(kernel)).map((row) => row.id)).toEqual([fresh.id])
    // One is still waiting: the sweep comes back for when it runs out.
    const next = await kernel.jobs.next('core.media_uploads_sweep')
    expect(next!.getTime()).toBeGreaterThan(Date.now() + 30 * 60_000)

    await kernel.db.execute(
      sql`UPDATE cms_media_uploads SET expires_at = now() - interval '1 minute'`,
    )
    await due()
    expect((await kernel.jobs.runDue()).ran).toBe(1)
    expect(await pendingRows(kernel)).toEqual([])
    expect(await kernel.jobs.next('core.media_uploads_sweep')).toBeNull()
  })

  it('give a large file longer to arrive than a small one', async () => {
    const { kernel } = await boot(directStorage(), 10 * 1024 * 1024 * 1024)
    const { cookie } = await signIn(kernel, 'author')
    const small = await begin(kernel, cookie, 'small.txt', 10)
    const large = await begin(kernel, cookie, 'large.mp4', 1024 * 1024 * 1024)
    const huge = await begin(kernel, cookie, 'huge.mp4', 9 * 1024 * 1024 * 1024)
    const hours = async (id: string) => {
      const [row] = await rows<{ hours: string }>(
        kernel,
        sql`SELECT extract(epoch FROM expires_at - created_at) / 3600 AS hours FROM cms_media_uploads WHERE id = ${id}`,
      )
      return Number(row!.hours)
    }
    expect(await hours(small.id)).toBeCloseTo(1, 1)
    // A gigabyte at 64 KiB a second.
    expect(await hours(large.id)).toBeCloseTo(4.55, 1)
    expect(await hours(huge.id)).toBeCloseTo(24, 1)
  })
})
