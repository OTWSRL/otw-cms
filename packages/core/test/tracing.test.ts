import { PGlite } from '@electric-sql/pglite'
import { context, trace } from '@opentelemetry/api'
import type { PluginContext, RequestTrace } from '@otwdesign/sdk'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { createKernel, type KernelOptions } from '../src/kernel'
import {
  currentTraceId,
  registerTracerProvider,
  traceQueries,
  TraceCollector,
  traced,
} from '../src/tracing'
import { memoryLogger, plugin } from './helpers'

declare module '@otwdesign/sdk' {
  interface Filters {
    'shop.price': [number, Record<string, never>]
  }
  interface Actions {
    'shop.viewed': { slug: string }
  }
}

// One provider per test file, as one per server process; each test gets a fresh collector state.
const collector = new TraceCollector()
registerTracerProvider(collector)
const tracer = trace.getTracer('test')

beforeEach(() => collector.setEnabled(true))

/** Runs `fn` as Next.js runs a request: inside a root span that ends with the response. */
async function request(
  path: string,
  fn: (id: string) => Promise<void>,
  keep = true,
): Promise<string> {
  return tracer.startActiveSpan(
    `GET ${path}`,
    { attributes: { 'http.method': 'GET', 'http.target': path, 'next.route': '/[...slug]' } },
    async (root) => {
      const id = currentTraceId()!
      if (keep) collector.keep(id)
      await fn(id)
      root.setAttribute('http.status_code', 200)
      root.end()
      return id
    },
  )
}

function tracedDb() {
  return drizzle(traceQueries(new PGlite()))
}

const shop = plugin('shop', {
  setup(cms: PluginContext) {
    cms.hooks.addFilter('shop.price', (price) => price + 1)
    cms.routes.page({
      name: 'product',
      path: '/product/:slug',
      load: async ({ params }) => {
        await cms.db.execute(sql`SELECT ${params.slug!}::text AS slug`)
        await cms.hooks.doAction('shop.viewed', { slug: params.slug! })
        return { price: await cms.hooks.applyFilters('shop.price', 10, {}) }
      },
      component: () => null,
    })
  },
})

const discounts = plugin('discounts', {
  requires: { shop: '*' },
  setup(cms: PluginContext) {
    cms.hooks.addFilter('shop.price', (price) => price - 2)
    cms.hooks.addAction('shop.viewed', async () => {
      await cms.db.execute(sql`SELECT 1`)
    })
  },
})

// As the performance plugin does: a kernel records requests only while a plugin asks it to.
const tracing = plugin('tracing', {
  setup(cms: PluginContext) {
    cms.traces.enable()
  },
})

function boot(options: Partial<KernelOptions> = {}) {
  return createKernel({
    db: tracedDb(),
    logger: memoryLogger(),
    strict: true,
    plugins: [shop, discounts, tracing],
    traces: collector,
    ...options,
  })
}

const spansOf = (trace: RequestTrace, kind: string) =>
  trace.spans.filter((span) => span.kind === kind)

describe('request traces', () => {
  it('times the request and attributes each query and hook to its plugin', async () => {
    const kernel = await boot()
    const id = await request('/product/mug', async () => {
      await kernel.resolvePage('/product/mug')
    })
    const recorded = collector.get(id)!

    expect(recorded).toMatchObject({
      method: 'GET',
      path: '/product/mug',
      route: '/[...slug]',
      status: 200,
    })
    expect(recorded.duration).toBeGreaterThan(0)
    expect(recorded.memory!.heapUsed).toBeGreaterThan(0)
    expect(recorded.spans[0]).toMatchObject({ kind: 'request', parentId: null, start: 0 })

    expect(spansOf(recorded, 'page')).toEqual([
      expect.objectContaining({ name: 'load shop.product', plugin: 'shop' }),
    ])
    const queries = spansOf(recorded, 'query')
    expect(queries.map((span) => span.plugin)).toEqual(['shop', 'discounts'])
    expect(queries[0]!.attributes).toMatchObject({
      'db.statement': 'SELECT $1::text AS slug',
      'db.params': 1,
      'db.rows': 1,
    })
    // Values never reach the trace.
    expect(JSON.stringify(recorded)).not.toContain('"mug"')

    expect(spansOf(recorded, 'hook').map((span) => [span.name, span.plugin])).toEqual([
      ['action shop.viewed', 'discounts'],
      ['filter shop.price', 'shop'],
      ['filter shop.price', 'discounts'],
    ])
  })

  it('records the boot of a kernel started during a request: setup and migrations per plugin', async () => {
    const id = await request('/', async () => {
      await boot({
        plugins: [
          tracing,
          plugin('notes', {
            migrations: [
              { id: '0001', up: (db) => db.execute(sql`CREATE TABLE notes (body text)`) },
            ],
          }),
        ],
      })
    })
    const recorded = collector.get(id)!
    expect(spansOf(recorded, 'boot')).toHaveLength(1)
    expect(spansOf(recorded, 'setup').map((span) => span.plugin)).toEqual(['notes', 'tracing'])
    expect(spansOf(recorded, 'migration').map((span) => span.name)).toContain('migrate notes/0001')
  })

  it('keeps only the requests a plugin asked for, and drops the rest when they end', async () => {
    const kept = await request('/a', async () => {})
    const dropped = await request('/b', async () => {}, false)
    expect(collector.get(kept)).toBeDefined()
    expect(collector.get(dropped)).toBeUndefined()
    expect(collector.list()[0]!.id).toBe(kept)
  })

  it('shows a kept request while it runs, without a duration yet', async () => {
    await request('/slow', async (id) => {
      expect(collector.get(id)).toMatchObject({ path: '/slow', duration: null })
      expect(collector.list().find((entry) => entry.id === id)).toBeDefined()
    })
  })

  it('records failures on the span that failed', async () => {
    const id = await request('/', async () => {
      await expect(
        traced('broken', { 'otw.kind': 'other' }, () => Promise.reject(new Error('disk full'))),
      ).rejects.toThrow('disk full')
    })
    expect(collector.get(id)!.spans.find((span) => span.name === 'broken')!.error).toBe('disk full')
  })

  it('caps the spans of one request', async () => {
    const id = await request('/', async () => {
      for (let i = 0; i < 2010; i++) tracer.startSpan(`span ${i}`).end()
    })
    const recorded = collector.get(id)!
    expect(recorded.spans).toHaveLength(2000)
    expect(recorded.droppedSpans).toBe(11)
  })

  it('lists spans that start in the same millisecond parents first', async () => {
    // Start times are whole milliseconds, and children end, so are collected, before parents.
    const startTime = Date.now()
    const root = tracer.startSpan('GET /same', { startTime })
    const id = root.spanContext().traceId
    collector.keep(id)
    const parent = trace.setSpan(context.active(), root)
    const child = tracer.startSpan('child', { startTime }, parent)
    tracer.startSpan('grandchild', { startTime }, trace.setSpan(parent, child)).end()
    child.end()
    root.end()
    expect(collector.get(id)!.spans.map((span) => span.name)).toEqual([
      'GET /same',
      'child',
      'grandchild',
    ])
  })

  it('records nothing while tracing is off, and runs the work all the same', async () => {
    collector.setEnabled(false)
    let ran = false
    await tracer.startActiveSpan(
      'GET /off',
      { attributes: { 'http.target': '/off' } },
      async (root) => {
        expect(currentTraceId()).toBeUndefined()
        await traced('work', {}, () => {
          ran = true
        })
        root.end()
      },
    )
    expect(ran).toBe(true)
    expect(collector.list().some((entry) => entry.path === '/off')).toBe(false)
  })
})

describe('cms.traces', () => {
  it('turns recording on while a plugin that enables it is active, and off when none is', async () => {
    collector.setEnabled(false)
    await boot({ plugins: [tracing] })
    expect(collector.enabled).toBe(true)
    await boot({ plugins: [shop] })
    expect(collector.enabled).toBe(false)
  })

  it('gives plugins the current request’s trace, to keep and read back', async () => {
    let api: PluginContext['traces'] | undefined
    await boot({
      plugins: [
        plugin('reader', {
          setup(cms: PluginContext) {
            cms.traces.enable()
            api = cms.traces
          },
        }),
      ],
    })
    expect(api!.available).toBe(true)
    const id = await request(
      '/kept-by-plugin',
      async (current) => {
        expect(api!.currentId()).toBe(current)
        api!.keep(current)
      },
      false,
    )
    expect(api!.get(id)!.path).toBe('/kept-by-plugin')
    expect(api!.list()[0]!.id).toBe(id)
  })
})
