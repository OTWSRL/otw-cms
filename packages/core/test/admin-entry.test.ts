import { defineAdmin, type PluginContext } from '@otwdesign/sdk'
import { describe, expect, it } from 'vitest'
import { bootKernel, memoryLogger, plugin } from './helpers'

declare module '@otwdesign/sdk' {
  interface Capabilities {
    'shelf.manage': true
  }
  interface Services {
    shelf: { count(): number }
  }
  interface Slots {
    'shelf.admin.book': { title: string }
  }
}

const booksPage = {
  name: 'books',
  path: '/books',
  title: 'Books',
  capability: 'shelf.manage',
  menu: { label: 'Books' },
  component: () => 'books',
} as const

/** The shelf plugin's main entry: what every part of the site loads. */
function shelfPlugin(setup?: (cms: PluginContext) => void) {
  return plugin('shelf', {
    setup(cms) {
      cms.auth.capability('shelf.manage', { label: 'Manage the shelf' })
      cms.services.provide('shelf', { count: () => 3 })
      setup?.(cms)
    },
  })
}

describe('admin entries', () => {
  it("run after every plugin's setup, in the plugins' order, with their services", async () => {
    const order: string[] = []
    const shelf = shelfPlugin(() => order.push('shelf'))
    const reader = plugin('reader', {
      requires: { shelf: '^1.0.0' },
      setup: () => void order.push('reader'),
    })
    const kernel = await bootKernel({
      plugins: [shelf, reader],
      admin: [
        defineAdmin(reader, () => void order.push('reader admin')),
        defineAdmin(shelf, (cms) => {
          order.push(`shelf admin, ${cms.services.get('shelf').count()} books`)
          cms.admin.page(booksPage)
        }),
      ],
    })
    expect(order).toEqual(['shelf', 'reader', 'shelf admin, 3 books', 'reader admin'])
    expect(kernel.adminUrl('shelf.books')).toBe('/admin/shelf/books')
  })

  it('skip plugins that are off', async () => {
    const ran: string[] = []
    const shelf = shelfPlugin()
    await bootKernel({
      plugins: [shelf],
      active: [],
      admin: [defineAdmin(shelf, () => void ran.push('shelf admin'))],
    })
    expect(ran).toEqual([])
  })

  it('must belong to an installed plugin, one each', async () => {
    const shelf = shelfPlugin()
    await expect(
      bootKernel({ plugins: [shelf], admin: [defineAdmin(plugin('ghost'), () => {})] }),
    ).rejects.toThrow('Admin entry for "ghost", which isn\'t installed')
    await expect(
      bootKernel({
        plugins: [shelf],
        admin: [defineAdmin(shelf, () => {}), defineAdmin(shelf, () => {})],
      }),
    ).rejects.toThrow('Plugin "shelf" has two admin entries')
  })

  it('that break turn their plugin off, unless the kernel is strict', async () => {
    const shelf = shelfPlugin()
    const broken = { plugins: [shelf], admin: [defineAdmin(shelf, () => fail('no shelf'))] }
    await expect(bootKernel(broken)).rejects.toThrow(
      'Plugin "shelf" failed during admin setup: no shelf',
    )
    const kernel = await bootKernel({ ...broken, strict: false, logger: memoryLogger() })
    expect(kernel.isActive('shelf')).toBe(false)
  })
})

describe('what goes where', () => {
  it("refuses admin pages, actions and settings screens in setup(): they'd reach every visitor", async () => {
    const registrations: ((cms: PluginContext) => void)[] = [
      (cms) => cms.admin.page(booksPage),
      (cms) => cms.admin.action({ name: 'shelve', capability: 'shelf.manage', handler: () => {} }),
      (cms) => cms.admin.settingsPage({ name: 'settings', path: '/settings', title: 'Shelf' }),
      (cms) =>
        cms.admin.settingsSection({
          name: 'shelf',
          page: 'core.general',
          title: 'Shelf',
          fields: [],
        }),
      (cms) => cms.admin.settingsFields({ section: 'core.site', fields: [] }),
    ]
    for (const register of registrations) {
      await expect(bootKernel({ plugins: [shelfPlugin(register)] })).rejects.toThrow(
        /in the plugin's admin entry/,
      )
    }
  })

  it("fills admin slots from the admin entry, and the site's from setup()", async () => {
    const empty = { component: () => null }
    for (const slot of ['admin.dashboard', 'shelf.admin.book'] as const) {
      await expect(
        bootKernel({ plugins: [shelfPlugin((cms) => cms.slots.fill(slot, empty))] }),
      ).rejects.toThrow(`Fill the admin slot "${slot}" in the plugin's admin entry`)
    }
    const shelf = shelfPlugin()
    await expect(
      bootKernel({
        plugins: [shelf],
        admin: [defineAdmin(shelf, (cms) => cms.slots.fill('site.footer', empty))],
      }),
    ).rejects.toThrow('Fill the site slot "site.footer" in setup()')

    const both = shelfPlugin((cms) => cms.slots.fill('site.footer', empty))
    const kernel = await bootKernel({
      plugins: [both],
      admin: [defineAdmin(both, (cms) => cms.slots.fill('shelf.admin.book', empty))],
    })
    expect(kernel.slot('site.footer')).toHaveLength(1)
    expect(kernel.slot('shelf.admin.book')).toHaveLength(1)
  })

  it('keeps roles and capabilities to setup(), so every part of the site agrees on them', async () => {
    const registrations: ((cms: PluginContext) => void)[] = [
      (cms) => cms.auth.capability('shelf.manage', { label: 'Manage the shelf' }),
      (cms) => cms.auth.role('librarian', { label: 'Librarian', capabilities: [] }),
      (cms) => cms.auth.grant('editor', ['shelf.manage']),
    ]
    for (const register of registrations) {
      const shelf = plugin('shelf')
      await expect(
        bootKernel({ plugins: [shelf], admin: [defineAdmin(shelf, register)] }),
      ).rejects.toThrow(/in setup\(\), so every part of the site agrees/)
    }
  })
})

describe('admin URLs', () => {
  async function shelfContext(withAdmin: boolean): Promise<PluginContext> {
    let context: PluginContext | undefined
    const shelf = shelfPlugin((cms) => {
      context = cms
    })
    await bootKernel({
      plugins: [shelf],
      admin: withAdmin ? [defineAdmin(shelf, (cms) => cms.admin.page(booksPage))] : undefined,
    })
    return context!
  }

  it('by path work everywhere, the storefront included', async () => {
    const cms = await shelfContext(false)
    expect(cms.admin.url('/')).toBe('/admin/shelf')
    expect(cms.admin.url('/books')).toBe('/admin/shelf/books')
    expect(cms.admin.url('/books/:id', { id: 'a b' })).toBe('/admin/shelf/books/a%20b')
    expect(() => cms.admin.url('/books/:id')).toThrow('needs parameter "id"')
  })

  it('by name work where the admin is loaded, and elsewhere say to use the path', async () => {
    expect((await shelfContext(true)).admin.url('shelf.books')).toBe('/admin/shelf/books')
    const storefront = await shelfContext(false)
    expect(() => storefront.admin.url('shelf.books')).toThrow(
      'Admin page names are known only where the admin is loaded ("shelf.books"). Here, link to the page by its path',
    )
  })
})

function fail(message: string): never {
  throw new Error(message)
}
