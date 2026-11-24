import { randomUUID } from 'node:crypto'
import type { Logger, MediaItem, MediaStorage, UploadTarget, User } from '@otwdesign/sdk'
import { MediaError } from '@otwdesign/sdk'
import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, lte, min, or, sql } from 'drizzle-orm'
import { mediaUploads } from './core-schema'
import type { DatabaseContext } from './database'
import type { JobService } from './jobs'
import { formatBytes, type InternalMediaService } from './media'
import { tempKey } from './media-files'

export const SWEEP_JOB = 'core.media_uploads_sweep'
/** How long a signed address takes a file's first byte. */
export const TARGET_TTL_MS = 15 * 60 * 1000
/** Uploads one account may have under way: each can hold a file in storage until it runs out. */
export const MAX_PENDING_UPLOADS = 20
/**
 * Uploads one account may have given up, or had refused, and not yet swept. Their signed
 * addresses still take bytes, so they're counted too, apart from those under way.
 */
export const MAX_ABANDONED_UPLOADS = 100
/** Tries at storing one upload before it's given up: a file that fails every time always will. */
export const MAX_COMPLETE_ATTEMPTS = 5

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_NAME = 255
/** An upload waits for its bytes as long as a slow line needs, between an hour and a day. */
const SLOW_BYTES_PER_SECOND = 64 * 1024
const MIN_WAIT_SECONDS = 60 * 60
const MAX_WAIT_SECONDS = 24 * 60 * 60
/** How long one `complete` may take before another may try: longer than any function runs. */
const CLAIM = sql`interval '5 minutes'`
const SWEEP_BATCH = 100
/** The shortest wait before the sweep looks again at what it left. */
const SWEEP_PAUSE_MS = 60_000
const SWEEP_KEY = 'sweep'

/** Why a direct upload couldn't go on; `MediaError` says what's wrong with the file itself. */
export class MediaUploadError extends Error {
  readonly code: 'unavailable' | 'not_found' | 'busy' | 'expired' | 'too_many' | 'not_sent'

  constructor(code: MediaUploadError['code'], message: string) {
    super(message)
    this.name = 'MediaUploadError'
    this.code = code
  }
}

/** A direct upload begun: where the browser sends the bytes, and the id it finishes with. */
export interface BegunUpload extends UploadTarget {
  id: string
  /** When the address stops taking the file. */
  expiresAt: Date
}

export interface MediaUploadServiceOptions {
  db: DatabaseContext
  logger: Logger
  /** Read on each call, as the media service reads it. */
  storage: () => MediaStorage
  media: Pick<InternalMediaService, 'accepts' | 'uploadThen' | 'get'>
  jobs: Pick<JobService, 'enqueue'>
  maxBytes: number
}

/**
 * Uploads a browser sends straight to storage, for hosts that cap a request's size. The site
 * signs an address for a temporary key, the browser sends the bytes there, and the site then
 * reads the file back and stores it as any upload: type checked by its bytes, sizes made.
 */
export interface MediaUploadService {
  /** What the uploader needs to know, or `null` when every upload goes through the site. */
  direct(): { minBytes: number } | null
  begin(user: User, input: { name: unknown; size: unknown; entry?: unknown }): Promise<BegunUpload>
  /** Stores the file the browser sent. Asked again, it answers the same item: `replay`. */
  complete(user: User, id: string): Promise<{ item: MediaItem; replay: boolean }>
  /** Gives an upload up: its row and whatever reached storage. */
  abort(user: User, id: string): Promise<void>
  /** Deletes the uploads that ran out, with their files, and returns how many. */
  sweep(): Promise<number>
}

function invalid(message: string): never {
  throw new MediaError('invalid_input', message)
}

/** What a storage answered, checked before a browser is told to use it. */
function checkedTarget(target: UploadTarget): UploadTarget {
  const headers = target?.headers
  const plain =
    typeof headers === 'object' &&
    headers !== null &&
    Object.values(headers).every((value) => typeof value === 'string')
  // A header's name is a token: anything else a browser refuses to set, and the upload stops.
  const named =
    plain && Object.keys(headers).every((name) => /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name))
  if (
    typeof target?.url !== 'string' ||
    !/^https?:\/\//i.test(target.url) ||
    target.method !== 'PUT' ||
    !named
  ) {
    throw new TypeError('The media storage answered an upload target that can’t be used')
  }
  return { url: target.url, method: 'PUT', headers: { ...headers } }
}

export function createMediaUploadService(options: MediaUploadServiceOptions): MediaUploadService {
  const { db, logger, media, maxBytes } = options
  const unclaimed = or(
    isNull(mediaUploads.claimedAt),
    lt(mediaUploads.claimedAt, sql`now() - ${CLAIM}`),
  )
  const waiting = and(isNull(mediaUploads.mediaId), isNull(mediaUploads.abandonedAt))

  /**
   * Gives an upload up without forgetting it: its signed address goes on taking bytes until it
   * runs out, so the row stays for the sweep to delete whatever arrives after this.
   */
  const abandon = async (id: string, key: string) => {
    await db.current
      .update(mediaUploads)
      .set({ abandonedAt: sql`now()`, claimedAt: null })
      .where(eq(mediaUploads.id, id))
    await remove(key)
  }

  /** Deletes a waiting file, logging rather than throwing: the sweep can't do better either. */
  const remove = async (key: string) => {
    try {
      await options.storage().delete(key)
    } catch (error) {
      logger.error('Could not delete a file waiting in storage; it’s left there', {
        file: key,
        error,
      })
    }
  }

  /** The file the browser sent, whole, or the reason it can't be used. */
  const sent = async (key: string, size: number): Promise<Uint8Array> => {
    const storage = options.storage()
    const info = await storage.stat(key)
    const file = info ? await storage.read(key) : null
    if (!info || !file) {
      throw new MediaUploadError('not_sent', 'The file hasn’t reached storage. Send it again.')
    }
    const wrongSize = () => invalid('The file that arrived isn’t the size that was announced.')
    if (info.size !== size) wrongSize()
    const data = new Uint8Array(size)
    let filled = 0
    const reader = file.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (filled + value.byteLength > size) {
        await reader.cancel()
        wrongSize()
      }
      data.set(value, filled)
      filled += value.byteLength
    }
    if (filled !== size) wrongSize()
    return data
  }

  /** Why an upload couldn't be claimed: finished already (its item), gone, run out, or busy. */
  const unclaimable = async (user: User, id: string) => {
    const [row] = await db.current
      .select({
        mediaId: mediaUploads.mediaId,
        abandoned: sql<boolean>`${mediaUploads.abandonedAt} IS NOT NULL`,
        expired: sql<boolean>`${mediaUploads.expiresAt} <= now()`,
      })
      .from(mediaUploads)
      .where(and(eq(mediaUploads.id, id), eq(mediaUploads.userId, user.id)))
      .limit(1)
    const item = row?.mediaId ? await media.get(row.mediaId) : null
    if (item) return { item, replay: true }
    if (!row || row.mediaId || row.abandoned) {
      throw new MediaUploadError('not_found', 'That upload no longer exists. Start it again.')
    }
    if (row.expired) {
      throw new MediaUploadError('expired', 'That upload has run out. Start it again.')
    }
    throw new MediaUploadError('busy', 'That upload is being stored already.')
  }

  const queueSweep = (at: Date) => options.jobs.enqueue(SWEEP_JOB, {}, { at, unique: SWEEP_KEY })

  return {
    direct() {
      const direct = options.storage().directUploads
      return direct ? { minBytes: direct.minBytes } : null
    },

    async begin(user, input) {
      const direct = options.storage().directUploads
      if (!direct) {
        throw new MediaUploadError('unavailable', 'This site takes uploads through its own form.')
      }
      const { name, size } = input
      if (
        typeof name !== 'string' ||
        name.trim() === '' ||
        name.length > MAX_NAME ||
        /\p{Cc}/u.test(name)
      ) {
        invalid('Send the file’s name.')
      }
      if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1) {
        invalid('Send the file’s size, in bytes.')
      }
      if (size > maxBytes) {
        throw new MediaError(
          'too_large',
          `The file is larger than the ${formatBytes(maxBytes)} limit.`,
        )
      }
      const entry = input.entry === undefined || input.entry === '' ? null : input.entry
      if (entry !== null && (typeof entry !== 'string' || !UUID.test(entry))) {
        invalid("The entry it's uploaded to doesn't exist")
      }
      await media.accepts(name, user.id)

      const id = randomUUID()
      const key = tempKey(id)
      const wait = Math.min(
        MAX_WAIT_SECONDS,
        Math.max(MIN_WAIT_SECONDS, Math.ceil(size / SLOW_BYTES_PER_SECOND)),
      )
      // Counted and added as one step for the account, so begins sent together can't all slip
      // under the limit.
      await db.transaction(async () => {
        await db.current.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`media-uploads:${user.id}`}, 0))`,
        )
        const [counts] = await db.current
          .select({
            waiting:
              sql<number>`count(*) FILTER (WHERE ${mediaUploads.abandonedAt} IS NULL AND ${mediaUploads.mediaId} IS NULL)`.mapWith(
                Number,
              ),
            abandoned:
              sql<number>`count(*) FILTER (WHERE ${mediaUploads.abandonedAt} IS NOT NULL)`.mapWith(
                Number,
              ),
          })
          .from(mediaUploads)
          .where(and(eq(mediaUploads.userId, user.id), gt(mediaUploads.expiresAt, sql`now()`)))
        if ((counts?.waiting ?? 0) >= MAX_PENDING_UPLOADS) {
          throw new MediaUploadError(
            'too_many',
            'Too many uploads are under way. Wait for some to finish.',
          )
        }
        if ((counts?.abandoned ?? 0) >= MAX_ABANDONED_UPLOADS) {
          throw new MediaUploadError(
            'too_many',
            'Too many uploads were given up lately. Try again in an hour.',
          )
        }
        await db.current.insert(mediaUploads).values({
          id,
          userId: user.id,
          key,
          filename: name,
          size,
          entryId: entry,
          expiresAt: sql`now() + make_interval(secs => ${wait})`,
        })
      })
      const expiresAt = new Date(Date.now() + TARGET_TTL_MS)
      let target: UploadTarget
      try {
        target = checkedTarget(await direct.target(key, { size, expiresAt }))
      } catch (error) {
        await db.current.delete(mediaUploads).where(eq(mediaUploads.id, id))
        throw error
      }
      await queueSweep(new Date(Date.now() + wait * 1000))
      return { id, ...target, expiresAt }
    },

    async complete(user, id) {
      if (typeof id !== 'string' || !UUID.test(id)) {
        throw new MediaUploadError('not_found', 'That upload no longer exists. Start it again.')
      }
      // One request stores it, however many ask: the claim is one statement.
      const [row] = await db.current
        .update(mediaUploads)
        .set({ claimedAt: sql`now()`, attempts: sql`${mediaUploads.attempts} + 1` })
        .where(
          and(
            eq(mediaUploads.id, id),
            eq(mediaUploads.userId, user.id),
            waiting,
            gt(mediaUploads.expiresAt, sql`now()`),
            unclaimed,
          ),
        )
        .returning()
      if (!row) return unclaimable(user, id)
      // Only the request holding this claim may let go of it, or give the upload up. Each claim
      // counts a try, so the count names the claim.
      const mine = and(eq(mediaUploads.id, row.id), eq(mediaUploads.attempts, row.attempts))

      try {
        const data = await sent(row.key, row.size)
        const item = await media.uploadThen(
          { name: row.filename, data },
          { by: user.id, ...(row.entryId ? { entryId: row.entryId } : {}) },
          // In the item's own transaction: an upload is finished exactly when its item exists.
          async (stored) => {
            const [finished] = await db.current
              .update(mediaUploads)
              .set({ mediaId: stored.id })
              .where(and(mine, waiting))
              .returning({ id: mediaUploads.id })
            // Another request took it over while this one was slow: its item stands, not this.
            if (!finished) {
              throw new MediaUploadError('busy', 'That upload is being stored already.')
            }
          },
        )
        await remove(row.key)
        return { item, replay: false }
      } catch (error) {
        try {
          const [held] = await db.current
            .select({ id: mediaUploads.id })
            .from(mediaUploads)
            .where(and(mine, waiting))
            .limit(1)
          if (!held) {
            // No longer this request's to tidy: another has it, or it's finished.
          } else if (error instanceof MediaError || row.attempts >= MAX_COMPLETE_ATTEMPTS) {
            // The file itself was refused, or fails every time: asking again would change nothing.
            await abandon(row.id, row.key)
          } else {
            // A passing problem: the browser may ask again.
            await db.current.update(mediaUploads).set({ claimedAt: null }).where(mine)
          }
        } catch (cleanup) {
          logger.error('Could not tidy up after a direct upload failed', { upload: id, cleanup })
        }
        throw error
      }
    },

    async abort(user, id) {
      if (typeof id !== 'string' || !UUID.test(id)) return
      const [row] = await db.current
        .select({ id: mediaUploads.id, key: mediaUploads.key })
        .from(mediaUploads)
        .where(and(eq(mediaUploads.id, id), eq(mediaUploads.userId, user.id), waiting, unclaimed))
        .limit(1)
      if (row) await abandon(row.id, row.key)
    },

    async sweep() {
      const expired = await db.root
        .select({ id: mediaUploads.id, key: mediaUploads.key })
        .from(mediaUploads)
        // One being stored this moment is left for the next sweep: its file is being read.
        .where(
          and(
            lte(mediaUploads.expiresAt, sql`now()`),
            or(unclaimed, isNotNull(mediaUploads.mediaId), isNotNull(mediaUploads.abandonedAt)),
          ),
        )
        .orderBy(asc(mediaUploads.expiresAt))
        .limit(SWEEP_BATCH)
      for (const { key } of expired) await remove(key)
      if (expired.length > 0) {
        await db.root.delete(mediaUploads).where(
          inArray(
            mediaUploads.id,
            expired.map((row) => row.id),
          ),
        )
      }
      // The next to run out, if any are left: a site with none stops sweeping. At once after a
      // full batch; otherwise no sooner than a minute, so one left for later isn't spun on.
      const [next] = await db.root.select({ at: min(mediaUploads.expiresAt) }).from(mediaUploads)
      if (next?.at) {
        const soonest = Date.now() + (expired.length === SWEEP_BATCH ? 0 : SWEEP_PAUSE_MS)
        await queueSweep(new Date(Math.max(next.at.getTime(), soonest)))
      }
      return expired.length
    },
  }
}
