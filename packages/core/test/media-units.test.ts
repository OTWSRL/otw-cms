import { describe, expect, it } from 'vitest'
import { coreImageSizes, formatBytes } from '../src/media'
import {
  fileKeys,
  isSafeKey,
  sanitizeFileName,
  titleFromFileName,
  uploadFolder,
} from '../src/media-files'
import { constrain, sizeDimensions } from '../src/media-images'
import { parseRange } from '../src/media-serve'
import { ALLOWED_MIMES, kindOf, matchesSignature, mimeForExtension } from '../src/media-types'

const text = (value: string) => new TextEncoder().encode(value)

describe('file names', () => {
  it('are made safe as sanitize_file_name() makes them, and lower case', () => {
    expect(sanitizeFileName('My Photo.JPG')).toEqual({ base: 'my-photo', extension: 'jpg' })
    expect(sanitizeFileName('Crème brûlée (2).png')).toEqual({
      base: 'creme-brulee-2',
      extension: 'png',
    })
    expect(sanitizeFileName('C:\\Users\\x\\shell.php.jpg')).toEqual({
      base: 'shell-php',
      extension: 'jpg',
    })
    expect(sanitizeFileName('../../etc/passwd')).toEqual({ base: 'passwd', extension: '' })
    expect(sanitizeFileName('.htaccess')).toEqual({ base: 'htaccess', extension: '' })
    expect(sanitizeFileName('日本.pdf')).toEqual({ base: 'file', extension: 'pdf' })
    expect(sanitizeFileName(`${'a'.repeat(300)}.txt`).base).toHaveLength(80)
  })

  it('give the title as uploaded, without the extension', () => {
    expect(titleFromFileName('/tmp/My Photo.JPG')).toBe('My Photo')
    expect(titleFromFileName('notes')).toBe('notes')
  })

  it('go in the month’s folder, numbered from 1 when taken, with sizes beside them', () => {
    const date = new Date('2026-01-31T23:30:00Z')
    expect(uploadFolder(date, true)).toBe('2026/01/')
    expect(uploadFolder(date, false)).toBe('')
    const name = { base: 'photo', extension: 'jpg' }
    expect(fileKeys('2026/01/', name, 0, { scaled: false, sizes: ['150x150'] })).toEqual({
      original: '2026/01/photo.jpg',
      main: '2026/01/photo.jpg',
      sizes: new Map([['150x150', '2026/01/photo-150x150.jpg']]),
    })
    expect(fileKeys('', name, 2, { scaled: true, sizes: [] })).toMatchObject({
      original: 'photo-2.jpg',
      main: 'photo-2-scaled.jpg',
    })
  })

  it('are refused as keys when they could reach outside the uploads', () => {
    expect(isSafeKey('2026/11/photo.jpg')).toBe(true)
    for (const key of [
      '',
      '../x.jpg',
      '2026/../x.jpg',
      '/etc/passwd',
      '.env',
      'a//b.jpg',
      'a\\b',
    ]) {
      expect(isSafeKey(key)).toBe(false)
    }
  })
})

describe('image sizes', () => {
  it('fit within their box, as wp_constrain_dimensions() does', () => {
    expect(constrain(1200, 800, 300, 300)).toEqual({ width: 300, height: 200 })
    expect(constrain(1200, 800, 768, 0)).toEqual({ width: 768, height: 512 })
    expect(constrain(100, 50, 300, 300)).toEqual({ width: 100, height: 50 })
  })

  it('crop from the center as far as the image reaches, and are never enlarged', () => {
    const thumbnail = { width: 150, height: 150, crop: true }
    expect(sizeDimensions(1200, 800, thumbnail)).toEqual({ width: 150, height: 150 })
    expect(sizeDimensions(200, 100, thumbnail)).toEqual({ width: 150, height: 100 })
    expect(sizeDimensions(150, 150, thumbnail)).toBeNull()
    expect(sizeDimensions(100, 80, { width: 300, height: 300, crop: false })).toBeNull()
  })

  it('come from Settings › Media for core, and 0 by 0 turns one off', () => {
    const sizes = coreImageSizes({
      thumbnail: ['150', '150', true],
      medium: ['0', '0'],
      large: ['1024', '1024'],
    })
    expect(sizes.map((size) => size.name)).toEqual([
      'thumbnail',
      'medium_large',
      'large',
      '1536x1536',
      '2048x2048',
    ])
  })

  it('show limits in megabytes', () => {
    expect(formatBytes(64 * 1024 * 1024)).toBe('64 MB')
    expect(formatBytes(1536 * 1024)).toBe('1.5 MB')
    expect(formatBytes(2000)).toBe('2 KB')
  })
})

describe('file types', () => {
  it('are looked up by extension, and sorted into the library’s kinds', () => {
    expect(mimeForExtension(ALLOWED_MIMES, 'JPEG')).toBe('image/jpeg')
    expect(mimeForExtension(ALLOWED_MIMES, 'html')).toBeNull()
    expect(mimeForExtension(ALLOWED_MIMES, 'svg')).toBeNull()
    expect(mimeForExtension(ALLOWED_MIMES, 'js')).toBeNull()
    expect(kindOf('image/png')).toBe('image')
    expect(kindOf('text/csv')).toBe('spreadsheet')
    expect(kindOf('application/zip')).toBe('archive')
    expect(kindOf('application/pdf')).toBe('document')
  })

  it('must have the bytes their extension promises', () => {
    expect(matchesSignature('application/pdf', text('%PDF-1.7\n'))).toBe(true)
    expect(matchesSignature('application/pdf', text('<html><script>'))).toBe(false)
    expect(matchesSignature('application/zip', new Uint8Array([0x50, 0x4b, 3, 4]))).toBe(true)
    expect(matchesSignature('text/plain', text('hello'))).toBe(true)
    expect(matchesSignature('text/plain', new Uint8Array([0x4d, 0x5a, 0, 0]))).toBe(false)
    expect(matchesSignature('audio/mpeg', text('ID3\u0004'))).toBe(true)
    expect(matchesSignature('video/mp4', text('\0\0\0\u0018ftypmp42'))).toBe(true)
    expect(matchesSignature('video/mp4', text('MZ program'))).toBe(false)
    // A type a plugin adds has no signature here: it's checked by extension only.
    expect(matchesSignature('text/markdown', text('# Hi'))).toBe(true)
  })
})

describe('byte ranges', () => {
  it('are read as RFC 9110 has them', () => {
    expect(parseRange(null, 100)).toBeNull()
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 })
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 })
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable')
    expect(parseRange('bytes=0-1,5-9', 100)).toBeNull()
    expect(parseRange('items=0-9', 100)).toBeNull()
  })
})
