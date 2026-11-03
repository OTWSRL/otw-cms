import type {
  ImageSize,
  ImageSizeDefinition,
  Logger,
  MediaApi,
  MediaChanges,
  MediaItem,
  MediaKind,
  MediaQuery,
  MediaStorage,
  MediaUpload,
  MediaUploadOptions,
} from '@otwdesign/sdk'
import { MediaError } from '@otwdesign/sdk'
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gte,
  ilike,
  inArray,
  isNull,
  like,
  lt,
  notInArray,
  not,
  or,
  sql,
  type SQL,
} from 'drizzle-orm'
import { entries, media, type StoredMediaSize } from './core-schema'
import type { DatabaseContext } from './database'
import type { HookBus } from './hooks'
import { fileKeys, sanitizeFileName, titleFromFileName, uploadFolder } from './media-files'
import { processImage, readImage, type ImageInfo, type ProcessedImage } from './media-images'
import {
  ALLOWED_MIMES,
  PROCESSED_IMAGES,
  kindOf,
  matchesSignature,
  mimeForExtension,
  mimesOfKind,
} from './media-types'

/** What the kernel serves: everything plugins call but the registrations. */
export type MediaService = Omit<MediaApi, 'imageSize' | 'storage'>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100
const MAX_SEARCH_WORDS = 10
/** How many numbered names an upload tries before giving up: `photo-1.jpg` … `photo-99.jpg`. */
const MAX_NAME_ATTEMPTS = 100
const KINDS: readonly MediaKind[] = [
  'image',
  'audio',
  'video',
  'document',
  'spreadsheet',
  'archive',
]
const PREFIXED = ['image', 'audio', 'video'] as const
const LIMITS = { title: 200, alt: 500, caption: 2000, description: 10_000 } as const
const SIZE_NAME = /^[a-z0-9][a-z0-9_-]*$/
const MAX_SIDE = 10_000
const TOUCHED = sql`greatest(now(), ${media.updatedAt} + interval '1 millisecond')`

function invalid(message: string): never {
  throw new MediaError('invalid_input', message)
}

function notFound(): never {
  throw new MediaError('not_found', 'That file no longer exists.')
}

function likeTerm(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
}

/** `64 MB`, for the size limit's message. */
export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  return mb >= 1 ? `${Number(mb.toFixed(1))} MB` : `${Math.ceil(bytes / 1024)} KB`
}

/** Plugins' image sizes, named under the plugin, like `add_image_size()`. */
export class ImageSizeStore {
  readonly #assertOpen: (what: string) => void
  readonly #sizes = new Map<string, ImageSize>()

  constructor(assertOpen: (what: string) => void) {
    this.#assertOpen = assertOpen
  }

  register(pluginId: string, name: string, definition: ImageSizeDefinition): void {
    const qualified = `${pluginId}.${name}`
    this.#assertOpen(`image size "${qualified}"`)
    if (typeof name !== 'string' || !SIZE_NAME.test(name)) {
      throw new Error(
        `Invalid image size name "${String(name)}": use lowercase letters, digits, _ and -`,
      )
    }
    const side = (value: unknown) =>
      Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_SIDE
    const { width, height, crop = false } = definition ?? {}
    if (!side(width) || !side(height) || (width === 0 && height === 0)) {
      throw new Error(
        `Image size "${qualified}" needs a width and a height from 0 to ${MAX_SIDE} pixels, not both 0`,
      )
    }
    if (typeof crop !== 'boolean')
      throw new Error(`Image size "${qualified}": crop is true or false`)
    if (this.#sizes.has(qualified))
      throw new Error(`Image size "${qualified}" is already registered`)
    this.#sizes.set(qualified, { name: qualified, width, height, crop })
  }

  list(): ImageSize[] {
    return [...this.#sizes.values()]
  }
}

/** Settings › Media's sizes, as strings of digits, made into core's sizes, WordPress's six. */
export function coreImageSizes(values: {
  thumbnail: [string, string, boolean]
  medium: [string, string]
  large: [string, string]
}): ImageSize[] {
  const n = (value: string) => (/^\d+$/.test(value) ? Number(value) : 0)
  const sizes: ImageSize[] = [
    {
      name: 'thumbnail',
      width: n(values.thumbnail[0]),
      height: n(values.thumbnail[1]),
      crop: values.thumbnail[2],
    },
    { name: 'medium', width: n(values.medium[0]), height: n(values.medium[1]), crop: false },
    { name: 'medium_large', width: 768, height: 0, crop: false },
    { name: 'large', width: n(values.large[0]), height: n(values.large[1]), crop: false },
    { name: '1536x1536', width: 1536, height: 1536, crop: false },
    { name: '2048x2048', width: 2048, height: 2048, crop: false },
  ]
  // A size set to 0 by 0 in Settings › Media is turned off, as in WordPress.
  return sizes.filter((size) => size.width > 0 || size.height > 0)
}

export interface MediaServiceOptions {
  db: DatabaseContext
  hooks: HookBus
  logger: Logger
  /** Read on each call: a plugin may provide the storage while setting up. */
  storage: () => MediaStorage
  imageSizes: () => ImageSize[]
  /** Settings › Media's year and month folders. */
  byMonth: () => boolean
  maxBytes: number
}

type MediaRow = typeof media.$inferSelect

export function createMediaService(options: MediaServiceOptions): MediaService {
  const { db, hooks, logger, maxBytes } = options

  const present = (row: MediaRow): MediaItem => {
    const storage = options.storage()
    const sizes = Object.fromEntries(
      Object.entries(row.sizes).map(([name, size]) => [
        name,
        { ...size, url: storage.url(size.file) },
      ]),
    )
    return {
      ...row,
      url: storage.url(row.file),
      originalUrl: row.originalFile ? storage.url(row.originalFile) : null,
      kind: kindOf(row.mimeType),
      sizes,
    }
  }

  /** Every file an item has: itself, its original and its sizes, each once. */
  const filesOf = (item: Pick<MediaItem, 'file' | 'originalFile' | 'sizes'>) => [
    ...new Set([
      item.file,
      ...(item.originalFile ? [item.originalFile] : []),
      ...Object.values(item.sizes).map((size) => size.file),
    ]),
  ]

  /** Deletes files, logging rather than throwing: the rows they belonged to are gone. */
  const removeFiles = async (keys: readonly string[]) => {
    const storage = options.storage()
    for (const key of keys) {
      try {
        await storage.delete(key)
      } catch (error) {
        logger.error("Could not delete an upload's file; it's left in storage", {
          file: key,
          error,
        })
      }
    }
  }

  const userId = (value: unknown): string | null => {
    if (value === undefined || value === null) return null
    if (typeof value !== 'string' || !UUID.test(value)) invalid('Who uploaded it must be a user id')
    return value
  }

  const entryRef = async (value: unknown): Promise<string | null> => {
    if (value === null || value === '') return null
    if (typeof value !== 'string' || !UUID.test(value)) {
      invalid("The entry it's uploaded to doesn't exist")
    }
    const [found] = await db.current
      .select({ id: entries.id })
      .from(entries)
      .where(eq(entries.id, value))
      .limit(1)
    if (!found) invalid("The entry it's uploaded to doesn't exist")
    return value
  }

  const text = (field: keyof typeof LIMITS, value: unknown): string => {
    if (typeof value !== 'string') invalid(`The ${field} must be text`)
    // Titles and alt text are one line; captions and descriptions keep their line breaks.
    const singleLine = field === 'title' || field === 'alt'
    const cleaned = value
      .replace(singleLine ? /\p{Cc}/gu : /(?![\n\t])\p{Cc}/gu, singleLine ? ' ' : '')
      .trim()
    if (cleaned.length > LIMITS[field]) {
      invalid(`The ${field} must be at most ${LIMITS[field]} characters`)
    }
    return cleaned
  }

  const lock = async (id: string): Promise<MediaItem> => {
    if (typeof id !== 'string' || !UUID.test(id)) notFound()
    const [row] = await db.current
      .select()
      .from(media)
      .where(eq(media.id, id))
      .for('update')
      .limit(1)
    return row ? present(row) : notFound()
  }

  /**
   * The file's real type, as `wp_check_filetype_and_ext()` finds it: from the extension, checked
   * against the bytes. An image whose extension lies is renamed, when its real type is allowed.
   */
  const checkType = async (
    name: { base: string; extension: string },
    data: Uint8Array,
    by: string | null,
  ): Promise<{ extension: string; mimeType: string; image: ImageInfo | null }> => {
    const mimes = await hooks.applyFilters('media.mimes', { ...ALLOWED_MIMES }, { by })
    const mimeType = name.extension ? mimeForExtension(mimes, name.extension) : null
    if (!mimeType) throw new MediaError('file_type', "This file type isn't allowed.")
    if (!(mimeType in PROCESSED_IMAGES)) {
      if (!matchesSignature(mimeType, data)) {
        throw new MediaError(
          'file_type',
          `The file's contents don't match its .${name.extension} extension.`,
        )
      }
      return { extension: name.extension, mimeType, image: null }
    }
    const image = await readImage(data)
    if (!image) {
      throw new MediaError(
        'file_type',
        `The file isn't a valid ${name.extension.toUpperCase()} image.`,
      )
    }
    if (image.mimeType === mimeType) return { extension: name.extension, mimeType, image }
    const extension = PROCESSED_IMAGES[image.mimeType]!
    if (mimeForExtension(mimes, extension) !== image.mimeType) {
      throw new MediaError('file_type', "This file type isn't allowed.")
    }
    return { extension, mimeType: image.mimeType, image }
  }

  /**
   * Stores an upload's files under the first free name, claiming each by creating it: two
   * uploads of `photo.jpg` at once get `photo.jpg` and `photo-1.jpg`, never one file.
   */
  const writeFiles = async (
    folder: string,
    name: { base: string; extension: string },
    data: Uint8Array,
    mimeType: string,
    processed: ProcessedImage | null,
  ) => {
    const storage = options.storage()
    const dimensions = (size: { width: number; height: number }) => `${size.width}x${size.height}`
    for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt++) {
      const keys = fileKeys(folder, name, attempt, {
        scaled: processed?.scaled !== null && processed?.scaled !== undefined,
        sizes: processed?.sizes.map(dimensions) ?? [],
      })
      const plan: [string, Uint8Array][] = [
        [keys.original, data],
        ...(processed?.scaled ? [[keys.main, processed.scaled.data] as [string, Uint8Array]] : []),
        ...(processed?.sizes.map(
          (size) => [keys.sizes.get(dimensions(size))!, size.data] as [string, Uint8Array],
        ) ?? []),
      ]
      const written: string[] = []
      try {
        for (const [key, bytes] of plan) {
          if (!(await storage.create(key, bytes, mimeType))) break
          written.push(key)
        }
      } catch (error) {
        await removeFiles(written)
        throw error
      }
      if (written.length === plan.length) return { keys, written }
      await removeFiles(written)
    }
    throw new MediaError(
      'invalid_input',
      `There's no free file name left for ${name.base}.${name.extension}; rename the file.`,
    )
  }

  const kindCondition = (kind: MediaKind): SQL => {
    if (!KINDS.includes(kind)) invalid(`The kind must be one of ${KINDS.join(', ')}`)
    if ((PREFIXED as readonly string[]).includes(kind)) return like(media.mimeType, `${kind}/%`)
    if (kind === 'spreadsheet' || kind === 'archive') {
      return inArray(media.mimeType, mimesOfKind(kind))
    }
    return and(
      ...PREFIXED.map((prefix) => not(like(media.mimeType, `${prefix}/%`))),
      notInArray(media.mimeType, [...mimesOfKind('spreadsheet'), ...mimesOfKind('archive')]),
    )!
  }

  const monthRange = (month: unknown): SQL => {
    if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      invalid('The month must be YYYY-MM')
    }
    const [year, number] = month.split('-').map(Number) as [number, number]
    const start = new Date(Date.UTC(year, number - 1, 1))
    const end = new Date(Date.UTC(year, number, 1))
    return and(gte(media.createdAt, start), lt(media.createdAt, end))!
  }

  const service: MediaService = {
    imageSizes: () => options.imageSizes(),

    async upload(file: MediaUpload, uploadOptions: MediaUploadOptions = {}) {
      if (!file || typeof file.name !== 'string' || !(file.data instanceof Uint8Array)) {
        invalid('Upload a file: its name and its bytes')
      }
      const { data } = file
      if (data.byteLength === 0) invalid('The file is empty.')
      if (data.byteLength > maxBytes) {
        throw new MediaError(
          'too_large',
          `The file is larger than the ${formatBytes(maxBytes)} limit.`,
        )
      }
      const by = userId(uploadOptions.by)
      const sanitized = sanitizeFileName(file.name)
      const { extension, mimeType, image } = await checkType(sanitized, data, by)
      const name = { base: sanitized.base, extension }
      const fields = {
        title: text('title', uploadOptions.title ?? (titleFromFileName(file.name) || name.base)),
        alt: text('alt', uploadOptions.alt ?? ''),
        caption: text('caption', uploadOptions.caption ?? ''),
        description: text('description', uploadOptions.description ?? ''),
      }
      const entryId =
        uploadOptions.entryId === undefined ? null : await entryRef(uploadOptions.entryId)

      const processed = image ? await processImage(data, image, options.imageSizes()) : null
      const createdAt = new Date()
      const folder = uploadFolder(createdAt, options.byMonth())
      const { keys, written } = await writeFiles(folder, name, data, mimeType, processed)
      const sizes: Record<string, StoredMediaSize> = {}
      for (const size of processed?.sizes ?? []) {
        const stored = {
          file: keys.sizes.get(`${size.width}x${size.height}`)!,
          width: size.width,
          height: size.height,
          mimeType,
          size: size.data.byteLength,
        }
        for (const sizeName of size.names) sizes[sizeName] = stored
      }
      try {
        return await db.transaction(async () => {
          const [row] = await db.current
            .insert(media)
            .values({
              authorId: by,
              entryId,
              file: keys.main,
              originalFile: processed?.scaled ? keys.original : null,
              filename: (file.name.split(/[\\/]/).pop() ?? '').slice(0, 255) || keys.original,
              mimeType,
              size: processed?.scaled ? processed.scaled.data.byteLength : data.byteLength,
              width: processed?.width ?? null,
              height: processed?.height ?? null,
              sizes,
              ...fields,
              createdAt,
              updatedAt: createdAt,
            })
            .returning()
          const item = present(row!)
          await hooks.doAction('media.uploaded', { item })
          return item
        })
      } catch (error) {
        await removeFiles(written)
        throw error
      }
    },

    async get(id) {
      if (typeof id !== 'string' || !UUID.test(id)) return null
      const [row] = await db.current.select().from(media).where(eq(media.id, id)).limit(1)
      return row ? present(row) : null
    },

    async getMany(ids) {
      if (!Array.isArray(ids)) invalid('Ask for files by a list of ids')
      const wanted = [...new Set(ids.filter((id) => typeof id === 'string' && UUID.test(id)))]
      if (wanted.length === 0) return []
      const rows = await db.current.select().from(media).where(inArray(media.id, wanted))
      const byId = new Map(rows.map((row) => [row.id, present(row)]))
      return wanted.map((id) => byId.get(id)).filter((item) => item !== undefined)
    },

    async list(query: MediaQuery = {}) {
      const { limit = DEFAULT_LIMIT, offset = 0, orderBy = 'date', order = 'desc' } = query
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        invalid(`The limit must be 1 to ${MAX_LIMIT}`)
      }
      if (!Number.isSafeInteger(offset) || offset < 0) invalid('The offset must be 0 or more')
      if (orderBy !== 'date' && orderBy !== 'title') invalid('Order by date or title')
      if (order !== 'asc' && order !== 'desc') invalid('Order asc or desc')
      const conditions: (SQL | undefined)[] = []
      if (query.kind !== undefined) conditions.push(kindCondition(query.kind))
      if (query.entryId === null) conditions.push(isNull(media.entryId))
      else if (query.entryId !== undefined) {
        if (typeof query.entryId !== 'string' || !UUID.test(query.entryId)) {
          return { items: [], total: 0 }
        }
        conditions.push(eq(media.entryId, query.entryId))
      }
      if (query.authorId !== undefined) {
        if (typeof query.authorId !== 'string' || !UUID.test(query.authorId)) {
          return { items: [], total: 0 }
        }
        conditions.push(eq(media.authorId, query.authorId))
      }
      if (query.search !== undefined) {
        if (typeof query.search !== 'string') invalid('Search for text')
        const words = query.search.trim().split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_WORDS)
        for (const word of words) {
          const pattern = likeTerm(word)
          conditions.push(or(ilike(media.title, pattern), ilike(media.filename, pattern)))
        }
      }
      if (query.month !== undefined) conditions.push(monthRange(query.month))
      const direction = order === 'asc' ? asc : desc
      const rows = await db.current
        .select({
          ...getTableColumns(media),
          total: sql<number>`count(*) over ()`.mapWith(Number),
        })
        .from(media)
        .where(and(...conditions))
        .orderBy(
          ...(orderBy === 'title'
            ? [direction(sql`lower(${media.title})`), direction(media.id)]
            : [direction(media.createdAt), direction(media.id)]),
        )
        .limit(limit)
        .offset(offset)
      return {
        items: rows.map(({ total: _total, ...row }) => present(row)),
        total: rows[0]?.total ?? 0,
      }
    },

    update: (id, changes: MediaChanges) =>
      db.transaction(async () => {
        const previous = await lock(id)
        if (!changes || typeof changes !== 'object') invalid('Say what to change')
        const values: Partial<typeof media.$inferInsert> = {}
        for (const field of ['title', 'alt', 'caption', 'description'] as const) {
          if (changes[field] !== undefined) values[field] = text(field, changes[field])
        }
        if (changes.entryId !== undefined) values.entryId = await entryRef(changes.entryId)
        const [row] = await db.current
          .update(media)
          .set({ ...values, updatedAt: TOUCHED })
          .where(eq(media.id, previous.id))
          .returning()
        const item = present(row!)
        await hooks.doAction('media.updated', { item, previous })
        return item
      }),

    delete: (id) =>
      db.transaction(async () => {
        const item = await lock(id)
        await db.current.delete(media).where(eq(media.id, item.id))
        await hooks.doAction('media.deleted', { item })
        // Files can't be put back, so they go only once the delete is committed.
        await db.afterCommit(() => removeFiles(filesOf(item)))
      }),

    async months() {
      const month = sql<string>`to_char(${media.createdAt} at time zone 'UTC', 'YYYY-MM')`
      const rows = await db.current.selectDistinct({ month }).from(media).orderBy(desc(month))
      return rows.map((row) => row.month)
    },
  }
  return service
}
