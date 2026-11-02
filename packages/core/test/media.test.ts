import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { MediaError, MediaStorage } from '@otw/sdk'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { localStorage } from '../src/media-storage'
import { bootKernel, plugin, signIn, tempDir } from './helpers'

/** A solid image of a size, encoded as `format`. */
async function image(
  width: number,
  height: number,
  format: 'jpeg' | 'png' | 'webp' = 'jpeg',
  orientation?: number,
): Promise<Uint8Array> {
  let pipeline = sharp({ create: { width, height, channels: 3, background: '#c0392b' } })
  if (orientation) pipeline = pipeline.withMetadata({ orientation })
  const buffer = await pipeline.toFormat(format).toBuffer()
  return new Uint8Array(buffer)
}

const bytes = (value: string) => new TextEncoder().encode(value)
const month = () => {
  const now = new Date()
  return `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/`
}
const dimensionsOf = async (path: string) => {
  const { width, height } = await sharp(path).metadata()
  return `${width}x${height}`
}

describe('uploading', () => {
  it('stores an image in the month’s folder with WordPress’s sizes, and who uploaded it', async () => {
    const dir = tempDir()
    const kernel = await bootKernel({ plugins: [], uploads: { dir } })
    const { user } = await signIn(kernel, 'author')
    const item = await kernel.media.upload(
      { name: 'My Photo.JPG', data: await image(1200, 800) },
      { by: user.id },
    )
    const folder = month()
    expect(item).toMatchObject({
      file: `${folder}my-photo.jpg`,
      url: `/uploads/${folder}my-photo.jpg`,
      originalFile: null,
      filename: 'My Photo.JPG',
      mimeType: 'image/jpeg',
      kind: 'image',
      width: 1200,
      height: 800,
      title: 'My Photo',
      authorId: user.id,
    })
    expect(
      Object.fromEntries(
        Object.entries(item.sizes).map(([name, size]) => [name, `${size.width}x${size.height}`]),
      ),
    ).toEqual({
      thumbnail: '150x150',
      medium: '300x200',
      medium_large: '768x512',
      large: '1024x683',
    })
    expect(item.sizes.medium).toMatchObject({
      file: `${folder}my-photo-300x200.jpg`,
      url: `/uploads/${folder}my-photo-300x200.jpg`,
    })
    for (const size of Object.values(item.sizes)) {
      expect(await dimensionsOf(join(dir, size.file))).toBe(`${size.width}x${size.height}`)
    }
    expect(await kernel.media.get(item.id)).toEqual(item)
  })

  it('scales a big image down to 2560 and keeps the original beside it', async () => {
    const dir = tempDir()
    const kernel = await bootKernel({ plugins: [], uploads: { dir } })
    const item = await kernel.media.upload({
      name: 'wide.png',
      data: await image(3000, 2000, 'png'),
    })
    const folder = month()
    expect(item).toMatchObject({
      file: `${folder}wide-scaled.png`,
      originalFile: `${folder}wide.png`,
      originalUrl: `/uploads/${folder}wide.png`,
      width: 2560,
      height: 1707,
    })
    expect(item.sizes['1536x1536']).toMatchObject({ width: 1536, height: 1024 })
    // From the scaled 2560×1707, as WordPress makes sizes: 1706.67 → 1707, then 1365.6 → 1366.
    expect(item.sizes['2048x2048']).toMatchObject({ width: 2048, height: 1366 })
    expect(await dimensionsOf(join(dir, item.file))).toBe('2560x1707')
    expect(await dimensionsOf(join(dir, item.originalFile!))).toBe('3000x2000')
  })

  it('turns a photo upright by its EXIF orientation, and keeps no metadata in sizes', async () => {
    const dir = tempDir()
    const kernel = await bootKernel({ plugins: [], uploads: { dir } })
    // Stored 400 wide; orientation 6 shows it turned, 400 tall.
    const item = await kernel.media.upload({
      name: 'phone.jpg',
      data: await image(400, 300, 'jpeg', 6),
    })
    expect(item).toMatchObject({ width: 300, height: 400 })
    expect(item.sizes.medium).toMatchObject({ width: 225, height: 300 })
    const medium = await sharp(join(dir, item.sizes.medium!.file)).metadata()
    expect(`${medium.width}x${medium.height}`).toBe('225x300')
    expect(medium.orientation).toBeUndefined()
  })

  it('numbers a name that’s taken, sizes’ names included, as wp_unique_filename()', async () => {
    const kernel = await bootKernel({ plugins: [] })
    const data = await image(400, 300)
    const first = await kernel.media.upload({ name: 'photo.jpg', data })
    const second = await kernel.media.upload({ name: 'Photo.jpg', data })
    // An upload named like the first one's thumbnail can't take that file.
    const third = await kernel.media.upload({ name: 'photo-150x150.jpg', data })
    const folder = month()
    expect([first.file, second.file, third.file]).toEqual([
      `${folder}photo.jpg`,
      `${folder}photo-1.jpg`,
      `${folder}photo-150x150-1.jpg`,
    ])
    expect(second.sizes.thumbnail?.file).toBe(`${folder}photo-1-150x150.jpg`)
  })

  it('gives two uploads of one name at once two files', async () => {
    const kernel = await bootKernel({ plugins: [] })
    const data = await image(200, 200)
    const items = await Promise.all(
      Array.from({ length: 4 }, () => kernel.media.upload({ name: 'same.jpg', data })),
    )
    expect(new Set(items.map((item) => item.file)).size).toBe(4)
  })

  it('puts files at the top of the uploads when Settings › Media says no folders', async () => {
    const kernel = await bootKernel({
      plugins: [],
      settings: { 'media.uploads_use_yearmonth_folders': false },
    })
    const item = await kernel.media.upload({ name: 'notes.txt', data: bytes('hello') })
    expect(item).toMatchObject({
      file: 'notes.txt',
      kind: 'document',
      width: null,
      height: null,
      sizes: {},
    })
  })

  it('refuses types that aren’t allowed, and contents that don’t match the extension', async () => {
    const kernel = await bootKernel({ plugins: [] })
    const refused = (name: string, data: Uint8Array) =>
      kernel.media.upload({ name, data }).then(
        () => 'uploaded',
        (error: MediaError) => `${error.code}: ${error.message}`,
      )
    expect(await refused('page.html', bytes('<p>hi'))).toBe(
      "file_type: This file type isn't allowed.",
    )
    expect(await refused('icon.svg', bytes('<svg/>'))).toBe(
      "file_type: This file type isn't allowed.",
    )
    expect(await refused('no-extension', bytes('hi'))).toBe(
      "file_type: This file type isn't allowed.",
    )
    expect(await refused('invoice.pdf', bytes('<html><script>alert(1)</script>'))).toBe(
      "file_type: The file's contents don't match its .pdf extension.",
    )
    expect(await refused('photo.jpg', bytes('not an image'))).toBe(
      "file_type: The file isn't a valid JPG image.",
    )
    expect(await refused('empty.txt', new Uint8Array())).toBe('invalid_input: The file is empty.')
  })

  it('renames an image whose extension lies, when its real type is allowed', async () => {
    const kernel = await bootKernel({ plugins: [] })
    const item = await kernel.media.upload({
      name: 'really-a.jpg',
      data: await image(50, 50, 'png'),
    })
    expect(item).toMatchObject({ file: `${month()}really-a.png`, mimeType: 'image/png' })
  })

  it('refuses a file over the limit', async () => {
    const kernel = await bootKernel({ plugins: [], uploads: { dir: tempDir(), maxBytes: 1024 } })
    await expect(
      kernel.media.upload({ name: 'big.txt', data: new Uint8Array(2048).fill(65) }),
    ).rejects.toThrow('The file is larger than the 1 KB limit.')
  })

  it('lets plugins remove types, and add their own, checked by extension', async () => {
    const markdown = plugin('docs', {
      setup(cms) {
        cms.hooks.addFilter('media.mimes', (mimes) => ({
          ...Object.fromEntries(Object.entries(mimes).filter(([extension]) => extension !== 'pdf')),
          md: 'text/markdown',
        }))
      },
    })
    const kernel = await bootKernel({ plugins: [markdown] })
    await expect(kernel.media.upload({ name: 'a.pdf', data: bytes('%PDF-1.7') })).rejects.toThrow(
      "This file type isn't allowed.",
    )
    expect((await kernel.media.upload({ name: 'readme.md', data: bytes('# Hi') })).mimeType).toBe(
      'text/markdown',
    )
  })

  it('makes plugins’ image sizes, named under the plugin', async () => {
    const lms = plugin('lms', {
      setup(cms) {
        cms.media.imageSize('card', { width: 400, height: 225, crop: true })
      },
    })
    const kernel = await bootKernel({ plugins: [lms] })
    const item = await kernel.media.upload({ name: 'course.jpg', data: await image(1200, 800) })
    expect(item.sizes['lms.card']).toMatchObject({ width: 400, height: 225 })
    expect(kernel.media.imageSizes().map((size) => size.name)).toContain('lms.card')
  })

  it('refuses image sizes that make no sense, and media storage from two plugins', async () => {
    const bad = plugin('bad', {
      setup(cms) {
        cms.media.imageSize('Huge!', { width: 1, height: 1 })
      },
    })
    await expect(bootKernel({ plugins: [bad] })).rejects.toThrow('Invalid image size name')
    const zero = plugin('zero', {
      setup(cms) {
        cms.media.imageSize('none', { width: 0, height: 0 })
      },
    })
    await expect(bootKernel({ plugins: [zero] })).rejects.toThrow('not both 0')
    const storing = (id: string) =>
      plugin(id, {
        setup(cms) {
          cms.media.storage(localStorage(tempDir()))
        },
      })
    await expect(bootKernel({ plugins: [storing('one'), storing('two')] })).rejects.toThrow(
      'only one can',
    )
  })

  it('keeps files where a plugin’s storage says', async () => {
    const written = new Map<string, Uint8Array>()
    const disk = localStorage(tempDir())
    const storage: MediaStorage = {
      ...disk,
      async create(key, data, type) {
        written.set(key, data)
        return disk.create(key, data, type)
      },
      url: (key) => `https://cdn.example.com/${key}`,
    }
    const cdn = plugin('cdn', {
      setup(cms) {
        cms.media.storage(storage)
      },
    })
    const kernel = await bootKernel({ plugins: [cdn] })
    const item = await kernel.media.upload({ name: 'a.txt', data: bytes('a') })
    expect(item.url).toBe(`https://cdn.example.com/${month()}a.txt`)
    expect([...written.keys()]).toEqual([item.file])
  })
})

describe('the library', () => {
  it('lists files by kind, search, month and what they’re uploaded to', async () => {
    const kernel = await bootKernel({ plugins: [] })
    const post = await kernel.content.create('core.post', { title: 'Hello' })
    const photo = await kernel.media.upload(
      { name: 'beach.jpg', data: await image(100, 100) },
      { entryId: post.id },
    )
    const sheet = await kernel.media.upload({ name: 'Budget.csv', data: bytes('a,b\n1,2') })
    const pdf = await kernel.media.upload({ name: 'Menu.pdf', data: bytes('%PDF-1.7') })
    const ids = async (query: Parameters<typeof kernel.media.list>[0]) =>
      (await kernel.media.list(query)).items.map((item) => item.id)
    expect(await ids({})).toEqual([pdf.id, sheet.id, photo.id])
    expect(await ids({ kind: 'image' })).toEqual([photo.id])
    expect(await ids({ kind: 'spreadsheet' })).toEqual([sheet.id])
    expect(await ids({ kind: 'document' })).toEqual([pdf.id])
    expect(await ids({ search: 'budg' })).toEqual([sheet.id])
    expect(await ids({ search: 'beach.jpg' })).toEqual([photo.id])
    expect(await ids({ entryId: post.id })).toEqual([photo.id])
    expect(await ids({ entryId: null })).toEqual([pdf.id, sheet.id])
    expect(await ids({ orderBy: 'title', order: 'asc' })).toEqual([photo.id, sheet.id, pdf.id])
    const thisMonth = month().slice(0, 7).replace('/', '-')
    expect(await kernel.media.months()).toEqual([thisMonth])
    expect(await ids({ month: thisMonth })).toHaveLength(3)
    expect(await ids({ month: '2001-01' })).toEqual([])
    expect((await kernel.media.list({ limit: 2 })).total).toBe(3)
    await expect(kernel.media.list({ month: '2026-13' })).rejects.toThrow('YYYY-MM')
    expect((await kernel.media.getMany([sheet.id, 'nope', photo.id])).map((i) => i.id)).toEqual([
      sheet.id,
      photo.id,
    ])
  })

  it('changes a file’s details, and checks them', async () => {
    const kernel = await bootKernel({ plugins: [] })
    const item = await kernel.media.upload({ name: 'a.jpg', data: await image(40, 40) })
    const changed = await kernel.media.update(item.id, {
      title: '  Sunset\nover the bay ',
      alt: 'A red square',
      caption: 'Line one\nLine two',
    })
    expect(changed).toMatchObject({
      title: 'Sunset over the bay',
      alt: 'A red square',
      caption: 'Line one\nLine two',
      file: item.file,
    })
    expect(changed.updatedAt.getTime()).toBeGreaterThan(item.updatedAt.getTime())
    await expect(kernel.media.update(item.id, { title: 'x'.repeat(201) })).rejects.toThrow(
      'at most 200',
    )
    await expect(
      kernel.media.update(item.id, { entryId: '00000000-0000-0000-0000-000000000000' }),
    ).rejects.toThrow("doesn't exist")
    await expect(kernel.media.update('nope', { title: 'x' })).rejects.toThrow('no longer exists')
  })

  it('deletes a file with every size, once the delete is committed', async () => {
    const dir = tempDir()
    const kernel = await bootKernel({ plugins: [], uploads: { dir } })
    const item = await kernel.media.upload({ name: 'big.jpg', data: await image(3000, 2000) })
    const files = [item.file, item.originalFile!, ...Object.values(item.sizes).map((s) => s.file)]
    for (const file of files) expect(existsSync(join(dir, file))).toBe(true)

    // A delete rolled back with its transaction leaves the files.
    await expect(
      kernel.transaction(async () => {
        await kernel.media.delete(item.id)
        throw new Error('changed my mind')
      }),
    ).rejects.toThrow('changed my mind')
    for (const file of files) expect(existsSync(join(dir, file))).toBe(true)

    await kernel.media.delete(item.id)
    expect(await kernel.media.get(item.id)).toBeNull()
    for (const file of files) expect(existsSync(join(dir, file))).toBe(false)
  })

  it('lets go of the entry a file was uploaded to when the entry is deleted', async () => {
    const kernel = await bootKernel({ plugins: [] })
    const post = await kernel.content.create('core.post', { title: 'Gone soon' })
    const item = await kernel.media.upload(
      { name: 'a.txt', data: bytes('a') },
      { entryId: post.id },
    )
    await kernel.content.trash(post.id)
    await kernel.content.delete(post.id)
    expect((await kernel.media.get(item.id))?.entryId).toBeNull()
  })

  it('runs hooks as WordPress’s attachment actions', async () => {
    const seen: string[] = []
    const watcher = plugin('watcher', {
      setup(cms) {
        cms.hooks.addAction(
          'media.uploaded',
          ({ item }) => void seen.push(`uploaded ${item.title}`),
        )
        cms.hooks.addAction(
          'media.updated',
          ({ item, previous }) => void seen.push(`updated ${previous.title} → ${item.title}`),
        )
        cms.hooks.addAction('media.deleted', ({ item }) => void seen.push(`deleted ${item.title}`))
      },
    })
    const kernel = await bootKernel({ plugins: [watcher] })
    const item = await kernel.media.upload({ name: 'one.txt', data: bytes('1') })
    await kernel.media.update(item.id, { title: 'two' })
    await kernel.media.delete(item.id)
    expect(seen).toEqual(['uploaded one', 'updated one → two', 'deleted two'])
  })
})
