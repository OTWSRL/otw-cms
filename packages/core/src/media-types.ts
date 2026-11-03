import type { MediaKind } from '@otwdesign/sdk'

/**
 * The file types people may upload, by extension, like WordPress's `get_allowed_mime_types()`:
 * its list for people without `unfiltered_html` (no HTML, JavaScript, Flash or programs), less
 * CSS, and the image formats browsers can't show. Plugins change it with the `media.mimes` filter.
 */
export const ALLOWED_MIMES: Readonly<Record<string, string>> = {
  'jpg|jpeg|jpe': 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  'mp4|m4v': 'video/mp4',
  'mov|qt': 'video/quicktime',
  webm: 'video/webm',
  ogv: 'video/ogg',
  '3gp|3gpp': 'video/3gpp',
  mp3: 'audio/mpeg',
  'm4a|m4b': 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  'ogg|oga': 'audio/ogg',
  flac: 'audio/flac',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  odt: 'application/vnd.oasis.opendocument.text',
  rtf: 'application/rtf',
  'txt|asc|srt': 'text/plain',
  vtt: 'text/vtt',
  ics: 'text/calendar',
  'pot|pps|ppt': 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppsx: 'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
  odp: 'application/vnd.oasis.opendocument.presentation',
  key: 'application/vnd.apple.keynote',
  pages: 'application/vnd.apple.pages',
  'xla|xls|xlt|xlw': 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  numbers: 'application/vnd.apple.numbers',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  zip: 'application/zip',
  'gz|gzip': 'application/x-gzip',
  tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed',
  rar: 'application/rar',
}

/** The images whose sizes the CMS makes, and the extension each gets when it's renamed. */
export const PROCESSED_IMAGES: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
}

const SPREADSHEETS = new Set([
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.apple.numbers',
  'text/csv',
  'text/tab-separated-values',
])

const ARCHIVES = new Set([
  'application/zip',
  'application/x-gzip',
  'application/x-tar',
  'application/x-7z-compressed',
  'application/rar',
])

/** The library's filter for a type, as WordPress's `wp_get_ext_types()` sorts them. */
export function kindOf(mimeType: string): MediaKind {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('audio/')) return 'audio'
  if (mimeType.startsWith('video/')) return 'video'
  if (SPREADSHEETS.has(mimeType)) return 'spreadsheet'
  if (ARCHIVES.has(mimeType)) return 'archive'
  return 'document'
}

/** The types of a kind that isn't told by its prefix, for filtering the library. */
export function mimesOfKind(kind: 'spreadsheet' | 'archive'): string[] {
  return [...(kind === 'spreadsheet' ? SPREADSHEETS : ARCHIVES)]
}

/** The type an extension has in `mimes`, a map keyed like `jpg|jpeg|jpe`. */
export function mimeForExtension(
  mimes: Readonly<Record<string, string>>,
  extension: string,
): string | null {
  const wanted = extension.toLowerCase()
  for (const [pattern, mime] of Object.entries(mimes)) {
    if (pattern.split('|').includes(wanted)) return mime
  }
  return null
}

const bytes = (data: Uint8Array, offset: number, expected: readonly number[]) =>
  expected.every((byte, i) => data[offset + i] === byte)
const ascii = (data: Uint8Array, offset: number, text: string) =>
  bytes(
    data,
    offset,
    [...text].map((char) => char.charCodeAt(0)),
  )

const ZIP = (data: Uint8Array) =>
  bytes(data, 0, [0x50, 0x4b, 0x03, 0x04]) || bytes(data, 0, [0x50, 0x4b, 0x05, 0x06])
const OLE = (data: Uint8Array) => bytes(data, 0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
const ISO_MEDIA = (data: Uint8Array) =>
  ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip', 'pnot'].some((atom) => ascii(data, 4, atom))
const ID3 = (data: Uint8Array) => ascii(data, 0, 'ID3')
const MPEG_FRAME = (data: Uint8Array) => data[0] === 0xff && ((data[1] ?? 0) & 0xe0) === 0xe0
/** Text has no NUL bytes; what else it may hold, the browser is told by its type and `nosniff`. */
const TEXT = (data: Uint8Array) => !data.subarray(0, 8192).includes(0)

/**
 * What each type's first bytes must be, as `wp_check_filetype_and_ext()` checks with `finfo`, so a
 * page or a program can't be uploaded under a harmless name. Images are checked by decoding them.
 */
const SIGNATURES: Readonly<Record<string, (data: Uint8Array) => boolean>> = {
  'video/mp4': ISO_MEDIA,
  'video/quicktime': ISO_MEDIA,
  'video/3gpp': ISO_MEDIA,
  'audio/mp4': ISO_MEDIA,
  'video/webm': (data) => bytes(data, 0, [0x1a, 0x45, 0xdf, 0xa3]),
  'video/ogg': (data) => ascii(data, 0, 'OggS'),
  'audio/ogg': (data) => ascii(data, 0, 'OggS'),
  'audio/mpeg': (data) => ID3(data) || MPEG_FRAME(data),
  'audio/aac': (data) => MPEG_FRAME(data) || ascii(data, 0, 'ADIF') || ID3(data),
  'audio/wav': (data) => ascii(data, 0, 'RIFF') && ascii(data, 8, 'WAVE'),
  'audio/flac': (data) => ascii(data, 0, 'fLaC') || ID3(data),
  // Some writers put a few bytes before the header; readers look in the first kilobyte.
  'application/pdf': (data) =>
    new TextDecoder('latin1').decode(data.subarray(0, 1024)).includes('%PDF-'),
  'application/msword': OLE,
  'application/vnd.ms-powerpoint': OLE,
  'application/vnd.ms-excel': OLE,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ZIP,
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ZIP,
  'application/vnd.openxmlformats-officedocument.presentationml.slideshow': ZIP,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ZIP,
  'application/vnd.oasis.opendocument.text': ZIP,
  'application/vnd.oasis.opendocument.presentation': ZIP,
  'application/vnd.oasis.opendocument.spreadsheet': ZIP,
  'application/vnd.apple.keynote': ZIP,
  'application/vnd.apple.pages': ZIP,
  'application/vnd.apple.numbers': ZIP,
  'application/zip': ZIP,
  'application/rtf': (data) => ascii(data, 0, '{\\rtf'),
  'application/x-gzip': (data) => bytes(data, 0, [0x1f, 0x8b]),
  'application/x-tar': (data) => ascii(data, 257, 'ustar'),
  'application/x-7z-compressed': (data) => bytes(data, 0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]),
  'application/rar': (data) => ascii(data, 0, 'Rar!\u001a\u0007'),
  'text/plain': TEXT,
  'text/vtt': TEXT,
  'text/calendar': TEXT,
  'text/csv': TEXT,
  'text/tab-separated-values': TEXT,
}

/**
 * Whether a file's bytes are what its type says. Types without a signature here (those plugins
 * add) pass: they're checked by extension only.
 */
export function matchesSignature(mimeType: string, data: Uint8Array): boolean {
  const check = SIGNATURES[mimeType]
  return check ? check(data) : true
}
