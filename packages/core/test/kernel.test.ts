import type { PluginContext } from '@otw/sdk'
import { sql } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { PluginBootError } from '../src/errors'
import { createKernel, type KernelOptions } from '../src/kernel'
import { createDb, memoryLogger, plugin } from './helpers'

declare module '@otw/sdk' {
  interface Slots {
    'shop.receipt': { orderId: string }
  }
  interface Registries {
    'test.gateways': { id: string }
  }
  interface Services {
    'test.commerce': { gatewayIds(): string[] }
  }
  interface Filters {
    'test.total': [number, { currency: string }]
  }
  interface Actions {
    'test.saved': { id: number }
    'test.paid': { id: number }
    'test.late': { id: number }
  }
}

function boot(options: Partial<KernelOptions> & Pick<KernelOptions, 'plugins'>) {
  return createKernel({ db: createDb(), logger: memoryLogger(), strict: true, ...options })
}

const notesTable = {
  id: 'create_notes',
  up: async (db: PluginContext['db']) => db.execute(sql`CREATE TABLE notes (body text NOT NULL)`),
}

async function noteBodies(db: PluginContext['db']): Promise<string[]> {
  const result = (await db.execute(sql`SELECT body FROM notes ORDER BY body`)) as unknown as {
    rows: { body: string }[]
  }
  return result.rows.map((row) => row.body)
}

describe('createKernel', () => {
  it('runs setup in dependency order and reports what loaded', async () => {
    const order: string[] = []
    const kernel = await boot({
      plugins: [
        plugin('stripe', {
          requires: { commerce: '^1.0.0' },
          setup: () => void order.push('stripe'),
        }),
        plugin('commerce', { setup: () => void order.push('commerce') }),
        plugin('broken-dep', { requires: { missing: '*' } }),
      ],
    })
    expect(order).toEqual(['commerce', 'stripe'])
    expect(kernel.active).toEqual(['commerce', 'stripe'])
    expect(kernel.skipped).toEqual([
      { id: 'broken-dep', reason: 'requires "missing" *, which is not installed' },
    ])
    expect(kernel.isActive('stripe')).toBe(true)
  })

  it('lets a plugin extend another through registries, services and filters', async () => {
    const kernel = await boot({
      plugins: [
        plugin('commerce', {
          setup(cms) {
            const gateways = cms.registries.define('test.gateways')
            cms.services.provide('test.commerce', {
              gatewayIds: () => gateways.list().map((g) => g.id),
            })
          },
        }),
        plugin('stripe', {
          requires: { commerce: '*' },
          setup(cms) {
            cms.registries.get('test.gateways').add({ id: 'stripe' })
            cms.hooks.addFilter('test.total', (total) => total - 5)
          },
        }),
      ],
    })
    expect(kernel.service('test.commerce').gatewayIds()).toEqual(['stripe'])
    expect(await kernel.applyFilters('test.total', 100, { currency: 'USD' })).toBe(95)
  })

  it('runs when() only for declared dependencies that loaded', async () => {
    const integrated = vi.fn()
    const lms = plugin('lms', {
      optional: { commerce: '*' },
      setup: (cms) => cms.when('commerce', integrated),
    })
    await boot({ plugins: [lms] })
    expect(integrated).not.toHaveBeenCalled()

    await boot({ plugins: [lms, plugin('commerce')] })
    expect(integrated).toHaveBeenCalledOnce()
  })

  it('rejects when() for undeclared dependencies', async () => {
    const sneaky = plugin('sneaky', { setup: (cms) => cms.when('commerce', () => undefined) })
    await expect(boot({ plugins: [sneaky, plugin('commerce')] })).rejects.toThrow(
      'without declaring it in requires or optional',
    )
  })

  it('refuses registrations after boot', async () => {
    let saved: PluginContext | undefined
    await boot({ plugins: [plugin('late', { setup: (cms) => void (saved = cms) })] })
    expect(() => saved!.hooks.addAction('test.late', () => undefined)).toThrow(
      'after boot; register it in setup()',
    )
    expect(() =>
      saved!.routes.page({ name: 'late', path: '/late', component: () => null }),
    ).toThrow('after boot')
  })

  it('reads settings', async () => {
    let currency: unknown
    await boot({
      settings: { 'site.locale': 'he-IL' },
      plugins: [plugin('a', { setup: (cms) => void (currency = cms.settings.get('site.locale')) })],
    })
    expect(currency).toBe('he-IL')
  })
})

describe('recovery mode', () => {
  it('boots without a plugin whose setup throws, and without its dependents', async () => {
    const logger = memoryLogger()
    const kernel = await createKernel({
      db: createDb(),
      logger,
      plugins: [
        plugin('commerce', {
          setup() {
            throw new Error('bad config')
          },
        }),
        plugin('stripe', { requires: { commerce: '*' } }),
        plugin('blog'),
      ],
    })
    expect(kernel.active).toEqual(['blog'])
    expect(kernel.skipped.map((s) => s.id).sort()).toEqual(['commerce', 'stripe'])
    expect(kernel.skipped.find((s) => s.id === 'commerce')?.reason).toContain('bad config')
    expect(
      logger.entries.some((e) => e.level === 'error' && e.context?.plugin === 'commerce'),
    ).toBe(true)
  })

  it('boots without a plugin whose migration fails', async () => {
    const kernel = await createKernel({
      db: createDb(),
      logger: memoryLogger(),
      plugins: [
        plugin('bad-schema', {
          migrations: [{ id: '1', up: async (db) => db.execute(sql`CREATE TABLE oops (`) }],
        }),
        plugin('fine'),
      ],
    })
    expect(kernel.active).toEqual(['fine'])
    expect(kernel.skipped[0]).toMatchObject({ id: 'bad-schema' })
  })

  it('throws in strict mode', async () => {
    const error = await boot({
      plugins: [plugin('commerce', { setup: () => Promise.reject(new Error('bad config')) })],
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PluginBootError)
    expect(error).toMatchObject({ pluginId: 'commerce', phase: 'setup' })
  })
})

describe('transactions', () => {
  it('routes cms.db through the active transaction, so hook writes roll back with it', async () => {
    let cms!: PluginContext
    const kernel = await boot({
      plugins: [
        plugin('notes', {
          migrations: [notesTable],
          setup(context) {
            cms = context
            context.hooks.addAction('test.saved', async () => {
              await cms.db.execute(sql`INSERT INTO notes (body) VALUES ('from hook')`)
            })
          },
        }),
      ],
    })

    await expect(
      kernel.transaction(async () => {
        await kernel.doAction('test.saved', { id: 1 })
        expect(await noteBodies(cms.db)).toEqual(['from hook'])
        throw new Error('checkout failed')
      }),
    ).rejects.toThrow('checkout failed')
    expect(await noteBodies(kernel.db)).toEqual([])
  })

  it('isolates a failing action in a savepoint so the transaction can still commit', async () => {
    let cms!: PluginContext
    const kernel = await boot({
      plugins: [
        plugin('notes', {
          migrations: [notesTable],
          setup(context) {
            cms = context
            context.hooks.addAction('test.paid', async () => {
              await cms.db.execute(sql`INSERT INTO notes (body) VALUES ('partial')`)
              await cms.db.execute(sql`INSERT INTO notes (body) VALUES (NULL)`)
            })
            context.hooks.addAction('test.paid', async () => {
              await cms.db.execute(sql`INSERT INTO notes (body) VALUES ('second handler')`)
            })
          },
        }),
      ],
    })

    await kernel.transaction(async () => {
      await cms.db.execute(sql`INSERT INTO notes (body) VALUES ('order paid')`)
      await kernel.doAction('test.paid', { id: 1 })
    })
    expect(await noteBodies(kernel.db)).toEqual(['order paid', 'second handler'])
  })
})

describe('pages and slots', () => {
  const shop = plugin('shop', {
    setup(cms) {
      cms.routes.page({
        name: 'product',
        path: '/product/:slug',
        load: ({ params }) => (params.slug === 'mug' ? { title: 'Mug' } : null),
        metadata: ({ data }) => ({ title: data.title }),
        component: () => null,
      })
      cms.slots.fill('header.nav', { component: () => 'Shop' })
    },
  })

  it('resolves a page, runs its loader and builds metadata', async () => {
    const kernel = await boot({ plugins: [shop] })
    const page = await kernel.resolvePage('/product/mug', { ref: 'home' })
    expect(page).toMatchObject({
      key: 'shop.product',
      pluginId: 'shop',
      props: { params: { slug: 'mug' }, searchParams: { ref: 'home' }, data: { title: 'Mug' } },
    })
    expect(await page!.metadata()).toEqual({ title: 'Mug' })
    expect(kernel.url('shop.product', { slug: 'mug' })).toBe('/product/mug')
    expect(kernel.slot('header.nav')).toHaveLength(1)
  })

  it('lets a plugin render fills other plugins put in its own slot, with props', async () => {
    let receipt: (() => unknown) | undefined
    const store = plugin('store', {
      setup(cms) {
        // Read at render time: the gateway below registers its fill after this setup runs.
        receipt = () => cms.slots.get('shop.receipt').map((Fill) => Fill({ orderId: 'A-1' }))
      },
    })
    const gateway = plugin('gateway', {
      requires: { store: '^1.0.0' },
      setup(cms) {
        cms.slots.fill('shop.receipt', { component: ({ orderId }) => `Paid ${orderId}` })
        cms.slots.fill('shop.receipt', { component: () => 'First', priority: 5 })
      },
    })
    await boot({ plugins: [store, gateway] })
    expect(receipt!()).toEqual(['First', 'Paid A-1'])
  })

  it('returns null when nothing matches or the loader finds nothing', async () => {
    const kernel = await boot({ plugins: [shop] })
    expect(await kernel.resolvePage('/product/teapot')).toBeNull()
    expect(await kernel.resolvePage('/nowhere')).toBeNull()
  })

  it('applies site route overrides to matching and URL building', async () => {
    const kernel = await boot({ plugins: [shop], routes: { 'shop.product': '/p/:slug' } })
    expect(await kernel.resolvePage('/p/mug')).not.toBeNull()
    expect(await kernel.resolvePage('/product/mug')).toBeNull()
    expect(kernel.url('shop.product', { slug: 'mug' })).toBe('/p/mug')
  })

  it('rejects overrides with different parameters and warns about unknown ones', async () => {
    await expect(boot({ plugins: [shop], routes: { 'shop.product': '/p/:id' } })).rejects.toThrow(
      'must use parameters [slug]',
    )
    const kernel = await boot({ plugins: [shop], routes: { 'shop.missing': '/x' } })
    expect(kernel.warnings).toContain(
      'Route override "shop.missing" does not match any registered page route',
    )
  })

  it('rejects reserved paths and conflicting routes across plugins', async () => {
    const admin = plugin('sneaky', {
      setup: (cms) => cms.routes.page({ name: 'x', path: '/admin/users', component: () => null }),
    })
    await expect(boot({ plugins: [admin] })).rejects.toThrow('reserved path')

    const clash = plugin('clash', {
      setup: (cms) =>
        cms.routes.page({ name: 'item', path: '/product/:id', component: () => null }),
    })
    await expect(boot({ plugins: [shop, clash] })).rejects.toThrow(
      'Route "shop.product" (/product/:slug) conflicts with "clash.item"',
    )
  })
})

describe('brand', () => {
  it('goes by the CMS’s own name unless the site gives it another', async () => {
    expect((await boot({ plugins: [] })).brand).toEqual({ name: 'OTW CMS' })
    const acme = { name: 'Acme Sites', url: 'https://acme.example' }
    expect((await boot({ plugins: [], brand: acme })).brand).toEqual(acme)
  })
})
