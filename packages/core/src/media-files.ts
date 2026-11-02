/** The longest file name kept, before its extension and any number. */
const MAX_BASE = 80

/**
 * A file name made safe for storage keys and URLs, like WordPress's `sanitize_file_name()`:
 * accents dropped, lower case (so names can't differ by case alone on case-insensitive disks),
 * anything but letters, digits, `_` and `-` turned into dashes. Dots inside the name become
 * dashes too, so `shell.php.jpg` can't be served as PHP by a misconfigured server.
 */
export function sanitizeFileName(name: string): { base: string; extension: string } {
  const last = name.split(/[\\/]/).pop() ?? ''
  const dot = last.lastIndexOf('.')
  const rawExtension = dot > 0 ? last.slice(dot + 1) : ''
  const rawBase = dot > 0 ? last.slice(0, dot) : last
  const clean = (text: string) =>
    text
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[-_]+|[-_]+$/g, '')
  const base = clean(rawBase)
    .slice(0, MAX_BASE)
    .replace(/[-_]+$/, '')
  return { base: base || 'file', extension: clean(rawExtension).replace(/[^a-z0-9]/g, '') }
}

/** A file's name as uploaded, without its extension or folders: the default title. */
export function titleFromFileName(name: string): string {
  const last = name.split(/[\\/]/).pop() ?? ''
  const dot = last.lastIndexOf('.')
  return (dot > 0 ? last.slice(0, dot) : last)
    .replace(/\p{Cc}/gu, '')
    .trim()
    .slice(0, 200)
}

/** The folder uploads go in: `2026/11/` (UTC), as WordPress's `wp_upload_dir()`, or none. */
export function uploadFolder(date: Date, byMonth: boolean): string {
  if (!byMonth) return ''
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  return `${date.getUTCFullYear()}/${month}/`
}

/** The keys one upload's files get: the file itself, then each other file, by role. */
export interface FileKeys {
  /** The file as uploaded. */
  original: string
  /** The one served: the original, or `-scaled` when it was scaled down. */
  main: string
  /** Each size's file, by its `WxH`. */
  sizes: Map<string, string>
}

/**
 * The keys for the `attempt`th try at a name: `photo.jpg`, then `photo-1.jpg`, as
 * `wp_unique_filename()` numbers them. Sizes are `photo-300x200.jpg`; a scaled image
 * `photo-scaled.jpg`.
 */
export function fileKeys(
  folder: string,
  name: { base: string; extension: string },
  attempt: number,
  options: { scaled: boolean; sizes: readonly string[] },
): FileKeys {
  const base = attempt === 0 ? name.base : `${name.base}-${attempt}`
  const key = (suffix: string) => `${folder}${base}${suffix}.${name.extension}`
  const original = key('')
  return {
    original,
    main: options.scaled ? key('-scaled') : original,
    sizes: new Map(options.sizes.map((size) => [size, key(`-${size}`)])),
  }
}

const SEGMENT = /^[a-z0-9_-][a-z0-9._-]*$/i
const MAX_KEY = 512

/** Whether `key` is one the CMS could have made: relative, with no `..` or hidden files. */
export function isSafeKey(key: string): boolean {
  if (key.length === 0 || key.length > MAX_KEY) return false
  return key.split('/').every((segment) => SEGMENT.test(segment) && !segment.includes('..'))
}
