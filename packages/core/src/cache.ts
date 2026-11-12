import type { CacheApi, CacheOptions, CacheStore } from '@otwdesign/sdk'
import { and, eq, gte, lt, sql } from 'drizzle-orm'
import { cache } from './core-schema'
import type { DatabaseContext } from './database'

const MAX_KEY = 200
/** One value, as JSON. */
const MAX_VALUE_BYTES = 1024 * 1024
/** What one server's memory holds at most; the least recently used go first. */
const MAX_ENTRIES = 5000
const MAX_BYTES = 64 * 1024 * 1024
const MAX_TTL = 10 * 365 * 24 * 60 * 60

interface MemoryEntry {
  value: unknown
  bytes: number
  /** In milliseconds since 1970, or `null` for no expiry. */
  expiresAt: number | null
}

/**
 * One server's cached values, least recently used first. A process has one, shared by its
 * kernels: a value one of them deletes is gone for the others.
 */
export interface MemoryCache {
  get(key: string, now: number): unknown
  set(key: string, value: unknown, bytes: number, expiresAt: number | null): void
  delete(key: string): void
  /** Deletes every key that starts with `prefix`. */
  flush(prefix: string): void
  readonly size: number
}

export function createMemoryCache(limits: { entries?: number; bytes?: number } = {}): MemoryCache {
  const maxEntries = limits.entries ?? MAX_ENTRIES
  const maxBytes = limits.bytes ?? MAX_BYTES
  // A Map keeps insertion order: the first key is the least recently used.
  const entries = new Map<string, MemoryEntry>()
  let bytes = 0
  const drop = (key: string) => {
    const entry = entries.get(key)
    if (!entry) return
    bytes -= entry.bytes
    entries.delete(key)
  }
  return {
    get(key, now) {
      const entry = entries.get(key)
      if (!entry) return undefined
      if (entry.expiresAt !== null && entry.expiresAt <= now) {
        drop(key)
        return undefined
      }
      // Used just now: to the back of the queue.
      entries.delete(key)
      entries.set(key, entry)
      return entry.value
    },
    set(key, value, size, expiresAt) {
      drop(key)
      entries.set(key, { value, bytes: size, expiresAt })
      bytes += size
      for (const oldest of entries.keys()) {
        if (entries.size <= maxEntries && bytes <= maxBytes) break
        drop(oldest)
      }
    },
    delete: drop,
    flush(prefix) {
      for (const key of [...entries.keys()]) if (key.startsWith(prefix)) drop(key)
    },
    get size() {
      return entries.size
    },
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

export interface CacheServiceOptions {
  db: DatabaseContext
  memory: MemoryCache
  /** The store a plugin provided, once every plugin has set up. */
  store(): CacheStore | null
  now?: () => number
}

export interface CacheService {
  /** `cms.cache` for one plugin: its keys are its own. */
  for(namespace: string): Omit<CacheApi, 'store'>
  /** Deletes the database's expired values, and returns how many. */
  sweep(): Promise<number>
}

/** `cms.cache`: memory, the database for what must last, or the store a plugin provides. */
export function createCacheService(options: CacheServiceOptions): CacheService {
  const { db, memory } = options
  const now = options.now ?? (() => Date.now())
  /** Computations under way, by key: a second caller waits for the first's. */
  const computing = new Map<string, Promise<unknown>>()

  const named = (namespace: string, key: string): string => {
    if (typeof key !== 'string' || key === '' || key.length > MAX_KEY) {
      throw new TypeError(`A cache key is 1 to ${MAX_KEY} characters`)
    }
    return `${namespace}:${key}`
  }

  /** The value as it's kept: plain data, as JSON and as a frozen copy. */
  const encode = (key: string, value: unknown) => {
    let json: string | undefined
    try {
      json = JSON.stringify(value)
    } catch {
      json = undefined
    }
    if (json === undefined) {
      throw new TypeError(`The value for cache key "${key}" must be plain data`)
    }
    const bytes = Buffer.byteLength(json)
    if (bytes > MAX_VALUE_BYTES) {
      throw new TypeError(`The value for cache key "${key}" is over 1 MB`)
    }
    return { json, bytes, copy: deepFreeze(JSON.parse(json) as unknown) }
  }

  const ttl = (key: string, { ttlSeconds }: CacheOptions): number | null => {
    if (ttlSeconds === undefined) return null
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > MAX_TTL) {
      throw new TypeError(`Cache key "${key}" needs a ttlSeconds above 0`)
    }
    return ttlSeconds
  }

  const read = async (full: string): Promise<unknown> => {
    const store = options.store()
    if (store) {
      const json = await store.get(full)
      return json === null ? undefined : deepFreeze(JSON.parse(json) as unknown)
    }
    return memory.get(full, now())
  }

  /** A durable value: a query, so only for callers that say theirs is durable. */
  const readDurable = async (full: string): Promise<unknown> => {
    const [row] = await db.current
      .select({ value: cache.value })
      .from(cache)
      .where(
        and(eq(cache.key, full), sql`(${cache.expiresAt} IS NULL OR ${cache.expiresAt} > now())`),
      )
      .limit(1)
    return row ? deepFreeze(JSON.parse(row.value) as unknown) : undefined
  }

  const write = async (full: string, value: unknown, cacheOptions: CacheOptions) => {
    const seconds = ttl(full, cacheOptions)
    const { json, bytes, copy } = encode(full, value)
    const store = options.store()
    if (store) {
      await store.set(full, json, seconds)
    } else if (cacheOptions.durable) {
      const expiresAt = seconds === null ? null : sql`now() + make_interval(secs => ${seconds})`
      await db.current
        .insert(cache)
        .values({ key: full, value: json, expiresAt })
        .onConflictDoUpdate({ target: cache.key, set: { value: json, expiresAt } })
    } else {
      memory.set(full, copy, bytes, seconds === null ? null : now() + seconds * 1000)
    }
    return copy
  }

  const get = async (full: string, durable: boolean | undefined): Promise<unknown> =>
    durable && !options.store() ? readDurable(full) : read(full)

  return {
    for: (namespace) => ({
      async get<T>(key: string, readOptions: Pick<CacheOptions, 'durable'> = {}) {
        return (await get(named(namespace, key), readOptions.durable)) as T | undefined
      },

      async set(key, value, cacheOptions = {}) {
        await write(named(namespace, key), value, cacheOptions)
      },

      async delete(key, readOptions = {}) {
        const full = named(namespace, key)
        const store = options.store()
        if (store) return store.delete(full)
        if (readOptions.durable) await db.current.delete(cache).where(eq(cache.key, full))
        else memory.delete(full)
      },

      async remember<T>(
        key: string,
        compute: () => T | Promise<T>,
        cacheOptions: CacheOptions = {},
      ) {
        const full = named(namespace, key)
        const held = await get(full, cacheOptions.durable)
        if (held !== undefined) return held as T
        const running = computing.get(full)
        if (running) return running as Promise<T>
        const work = (async () => (await write(full, await compute(), cacheOptions)) as T)()
        computing.set(full, work)
        try {
          return await work
        } finally {
          computing.delete(full)
        }
      },

      async flush() {
        const prefix = `${namespace}:`
        const store = options.store()
        if (store) return store.flush(prefix)
        memory.flush(prefix)
        // Every key from "shop:" up to, not including, "shop;", the character after the colon:
        // a range the primary key's index answers.
        await db.current
          .delete(cache)
          .where(and(gte(cache.key, prefix), lt(cache.key, `${namespace};`)))
      },
    }),

    async sweep() {
      const deleted = await db.root
        .delete(cache)
        .where(lt(cache.expiresAt, sql`now()`))
        .returning({ key: cache.key })
      return deleted.length
    },
  }
}
