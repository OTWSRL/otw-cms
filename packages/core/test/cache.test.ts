import { defineAdmin, type CacheStore, type PluginContext } from '@otwdesign/sdk'
import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createMemoryCache } from '../src/cache'
import type { Kernel, KernelOptions } from '../src/kernel'
import { bootKernel, plugin } from './helpers'

/** Two plugins that cache, each handing its context to the test. */
function plugins() {
  const contexts: Record<string, PluginContext> = {}
  const make = (id: string) => plugin(id, { setup: (cms) => void (contexts[id] = cms) })
  return { definitions: [make('shop'), make('blog')], cms: (id: string) => contexts[id]!.cache }
}

async function site(extra: Partial<KernelOptions> = {}) {
  const { definitions, cms } = plugins()
  const kernel = await bootKernel({ plugins: definitions, ...extra })
  return { kernel, shop: cms('shop'), blog: cms('blog') }
}

const rows = async (kernel: Kernel) => {
  const result = (await kernel.db.execute(
    sql`SELECT key, value FROM cms_cache ORDER BY key`,
  )) as unknown as { rows: { key: string; value: string }[] }
  return result.rows.map((row) => [row.key, JSON.parse(row.value)])
}

describe('cms.cache in memory', () => {
  it('keeps a value, a copy of it, frozen, and forgets it when told', async () => {
    const { kernel, shop } = await site()
    expect(await shop.get('rates')).toBeUndefined()
    const rates = { eur: 1, usd: 1.1, zones: ['eu', 'us'] }
    await shop.set('rates', rates)
    rates.usd = 2

    const cached = await shop.get<typeof rates>('rates')
    expect(cached).toEqual({ eur: 1, usd: 1.1, zones: ['eu', 'us'] })
    expect(Object.isFrozen(cached)).toBe(true)
    expect(Object.isFrozen(cached!.zones)).toBe(true)
    // The same object each time: reading costs no copy.
    expect(await shop.get('rates')).toBe(cached)
    // Nothing was written to the database.
    expect(await rows(kernel)).toEqual([])

    await shop.delete('rates')
    expect(await shop.get('rates')).toBeUndefined()
  })

  it('keeps null, false and 0 apart from nothing', async () => {
    const { shop } = await site()
    for (const value of [null, false, 0, '']) {
      await shop.set('empty', value)
      expect(await shop.get('empty')).toBe(value)
    }
  })

  it('gives each plugin keys of its own, and flushes only its own', async () => {
    const { kernel, shop, blog } = await site()
    await shop.set('count', 1)
    await blog.set('count', 2)
    await kernel.cache.set('count', 3)
    expect([
      await shop.get('count'),
      await blog.get('count'),
      await kernel.cache.get('count'),
    ]).toEqual([1, 2, 3])
    await shop.flush()
    expect([await shop.get('count'), await blog.get('count')]).toEqual([undefined, 2])
  })

  it('forgets a value when its time is up', async () => {
    let now = 1_000_000
    const { shop } = await site({ cacheMemory: createMemoryCache() })
    // The service reads the clock through Date.now; move it.
    const realNow = Date.now
    Date.now = () => now
    try {
      await shop.set('quote', 'fresh', { ttlSeconds: 60 })
      now += 59_000
      expect(await shop.get('quote')).toBe('fresh')
      now += 1000
      expect(await shop.get('quote')).toBeUndefined()
    } finally {
      Date.now = realNow
    }
  })

  it('refuses what isn’t plain data, what is too big, and keys and times that make no sense', async () => {
    const { shop } = await site()
    await expect(shop.set('n', 10n)).rejects.toThrow('must be plain data')
    await expect(shop.set('n', undefined)).rejects.toThrow('must be plain data')
    await expect(shop.set('big', 'x'.repeat(1024 * 1024 + 1))).rejects.toThrow('over 1 MB')
    await expect(shop.set('', 1)).rejects.toThrow('1 to 200 characters')
    await expect(shop.get('k'.repeat(201))).rejects.toThrow('1 to 200 characters')
    await expect(shop.set('n', 1, { ttlSeconds: 0 })).rejects.toThrow('ttlSeconds above 0')
  })

  it('is one for the process when the app shares it, so a new kernel still has the values', async () => {
    const cacheMemory = createMemoryCache()
    const first = await site({ cacheMemory })
    await first.shop.set('rates', { eur: 1 })
    const second = await site({ cacheMemory })
    expect(await second.shop.get('rates')).toEqual({ eur: 1 })
    await second.shop.delete('rates')
    expect(await first.shop.get('rates')).toBeUndefined()
  })
})

describe('the memory itself', () => {
  it('pushes out the least recently used when it holds too many, or too much', () => {
    const memory = createMemoryCache({ entries: 3, bytes: 100 })
    for (const key of ['a', 'b', 'c']) memory.set(key, key, 10, null)
    // Used again: "a" is now the newest.
    expect(memory.get('a', 0)).toBe('a')
    memory.set('d', 'd', 10, null)
    expect(['a', 'b', 'c', 'd'].map((key) => memory.get(key, 0))).toEqual([
      'a',
      undefined,
      'c',
      'd',
    ])

    memory.set('large', 'large', 85, null)
    expect(memory.size).toBe(2)
    expect(memory.get('large', 0)).toBe('large')
    expect(memory.get('d', 0)).toBe('d')

    memory.flush('la')
    expect(memory.size).toBe(1)
  })
})

describe('remember', () => {
  it('computes once, and gives the cached value after', async () => {
    const { shop } = await site()
    let calls = 0
    const rates = () => shop.remember('rates', async () => ({ eur: ++calls }), { ttlSeconds: 60 })
    expect(await rates()).toEqual({ eur: 1 })
    expect(await rates()).toEqual({ eur: 1 })
    expect(calls).toBe(1)
  })

  it('has callers at the same moment wait for one computation', async () => {
    const { shop } = await site()
    let calls = 0
    let finish!: (value: number) => void
    const compute = () => {
      calls++
      return new Promise<number>((resolve) => (finish = resolve))
    }
    const both = Promise.all([shop.remember('slow', compute), shop.remember('slow', compute)])
    await new Promise((resolve) => setTimeout(resolve, 10))
    finish(42)
    expect(await both).toEqual([42, 42])
    expect(calls).toBe(1)
  })

  it('caches nothing when the computation fails', async () => {
    const { shop } = await site()
    await expect(
      shop.remember('rates', () => {
        throw new Error('The bank is closed')
      }),
    ).rejects.toThrow('The bank is closed')
    expect(await shop.remember('rates', () => 'open')).toBe('open')
  })
})

describe('durable values', () => {
  it('are kept in the database, for every kernel on it, until their time is up', async () => {
    const first = await site()
    await first.shop.set('token', { value: 'abc' }, { durable: true, ttlSeconds: 3600 })
    await first.shop.set('forever', 1, { durable: true })
    expect(await rows(first.kernel)).toEqual([
      ['shop:forever', 1],
      ['shop:token', { value: 'abc' }],
    ])
    // Asked for as it was kept: memory doesn't have it.
    expect(await first.shop.get('token')).toBeUndefined()
    expect(await first.shop.get('token', { durable: true })).toEqual({ value: 'abc' })

    const second = await site({ db: first.kernel.db })
    expect(await second.shop.get('token', { durable: true })).toEqual({ value: 'abc' })

    await first.kernel.db.execute(
      sql`UPDATE cms_cache SET expires_at = now() - interval '1 second' WHERE key = 'shop:token'`,
    )
    expect(await second.shop.get('token', { durable: true })).toBeUndefined()
    expect(await second.shop.get('forever', { durable: true })).toBe(1)
  })

  it('are replaced by a new set, deleted, and flushed with the plugin’s own', async () => {
    const { kernel, shop, blog } = await site()
    await shop.set('token', 'old', { durable: true })
    await shop.set('token', 'new', { durable: true, ttlSeconds: 60 })
    await shop.set('other', 1, { durable: true })
    // A plugin whose id starts the same: its keys aren't the shop's.
    await kernel.db.execute(sql`INSERT INTO cms_cache (key, value) VALUES ('shop-extra:x', '1')`)
    await blog.set('token', 'blog', { durable: true })
    expect(await shop.get('token', { durable: true })).toBe('new')

    await shop.delete('other', { durable: true })
    expect((await rows(kernel)).map(([key]) => key)).toEqual([
      'blog:token',
      'shop-extra:x',
      'shop:token',
    ])
    await shop.flush()
    expect((await rows(kernel)).map(([key]) => key)).toEqual(['blog:token', 'shop-extra:x'])
  })

  it('remember a value across kernels', async () => {
    const first = await site()
    let calls = 0
    const compute = () => ++calls
    expect(await first.shop.remember('n', compute, { durable: true })).toBe(1)
    const second = await site({ db: first.kernel.db })
    expect(await second.shop.remember('n', compute, { durable: true })).toBe(1)
    expect(calls).toBe(1)
  })

  it('are swept by the daily cleanup once expired', async () => {
    const { kernel, shop } = await site()
    await shop.set('old', 1, { durable: true, ttlSeconds: 60 })
    await shop.set('fresh', 2, { durable: true, ttlSeconds: 3600 })
    await shop.set('forever', 3, { durable: true })
    await kernel.db.execute(
      sql`UPDATE cms_cache SET expires_at = now() - interval '1 minute' WHERE key = 'shop:old'`,
    )
    await kernel.jobs.enqueue('core.cleanup', {})
    await kernel.jobs.runDue()
    expect((await rows(kernel)).map(([key]) => key)).toEqual(['shop:forever', 'shop:fresh'])
  })
})

describe('a plugin’s cache store', () => {
  /** A stand-in for Redis: a Map, with the calls it got. */
  function redis() {
    const data = new Map<string, string>()
    const calls: string[] = []
    const store: CacheStore = {
      get: async (key) => (calls.push(`get ${key}`), data.get(key) ?? null),
      set: async (key, value, ttl) => void (calls.push(`set ${key} ${ttl}`), data.set(key, value)),
      delete: async (key) => void (calls.push(`delete ${key}`), data.delete(key)),
      flush: async (prefix) => {
        calls.push(`flush ${prefix}`)
        for (const key of [...data.keys()]) if (key.startsWith(prefix)) data.delete(key)
      },
    }
    return { store, data, calls }
  }

  it('takes everything, durable or not, in place of memory and the database', async () => {
    const { store, data, calls } = redis()
    const contexts: Record<string, PluginContext> = {}
    const kernel = await bootKernel({
      plugins: [
        plugin('redis', { setup: (cms) => cms.cache.store(store) }),
        plugin('shop', { setup: (cms) => void (contexts.shop = cms) }),
      ],
    })
    const shop = contexts.shop!.cache
    await shop.set('rates', { eur: 1 }, { ttlSeconds: 60 })
    await shop.set('token', 'abc', { durable: true })
    expect(data).toEqual(
      new Map([
        ['shop:rates', '{"eur":1}'],
        ['shop:token', '"abc"'],
      ]),
    )
    expect(await shop.get('rates')).toEqual({ eur: 1 })
    expect(await shop.get('token', { durable: true })).toBe('abc')
    expect(await shop.remember('rates', () => 'never computed')).toEqual({ eur: 1 })
    await shop.delete('token')
    await shop.flush()
    expect(data.size).toBe(0)
    expect(calls).toEqual([
      'set shop:rates 60',
      'set shop:token null',
      'get shop:rates',
      'get shop:token',
      'get shop:rates',
      'delete shop:token',
      'flush shop:',
    ])
    expect(await rows(kernel)).toEqual([])
  })

  it('is provided in setup(), by one plugin, with every method', async () => {
    const { store } = redis()
    const two = bootKernel({
      plugins: [
        plugin('redis', { setup: (cms) => cms.cache.store(store) }),
        plugin('memcached', { setup: (cms) => cms.cache.store(store) }),
      ],
    })
    await expect(two).rejects.toThrow('already does; only one can')
    await expect(
      bootKernel({ plugins: [plugin('redis', { setup: (cms) => cms.cache.store({} as never) })] }),
    ).rejects.toThrow('needs get, set, delete, flush')
    const definition = plugin('redis')
    await expect(
      bootKernel({
        plugins: [definition],
        admin: [defineAdmin(definition, (cms) => cms.cache.store(store))],
      }),
    ).rejects.toThrow('Provide the cache store in setup()')
  })
})
