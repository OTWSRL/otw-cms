import { ActionError, type PluginDefinition } from '@cms/sdk'
import { describe, expect, it } from 'vitest'
import { bootKernel, formPost, ORIGIN, plugin, redirectOf, signIn } from './helpers'

declare module '@cms/sdk' {
  interface Capabilities {
    'shop.manage': true
    'shop.undeclared': true
  }
}

function shopPlugin(log: string[] = []): PluginDefinition {
  return plugin('shop', {
    name: 'Shop',
    setup(cms) {
      cms.auth.capability('shop.manage', { label: 'Manage the shop', roles: ['shop_manager'] })
      cms.auth.role('shop_manager', { label: 'Shop manager', capabilities: ['core.access_admin'] })
      cms.auth.role('support', { label: 'Support', capabilities: ['core.access_admin'] })

      cms.admin.page({
        name: 'orders',
        path: '/orders',
        title: 'Orders',
        capability: 'shop.manage',
        menu: { label: 'Orders', order: 20 },
        load: () => ['A-1'],
        component: ({ data }) => data.join(','),
      })
      cms.admin.page({
        name: 'products',
        path: '/products',
        title: 'Products',
        capability: 'shop.manage',
        menu: { label: 'Products', order: 10 },
        component: () => 'products',
      })
      cms.admin.page({
        name: 'order',
        path: '/orders/:id',
        capability: 'shop.manage',
        load: ({ params }) => (params.id === 'missing' ? null : params.id!),
        title: ({ data }) => `Order ${data}`,
        component: ({ data }) => data,
      })

      cms.admin.action({
        name: 'rename',
        capability: 'shop.manage',
        handler({ form, user }) {
          const name = form.get('name')
          if (!name) throw new ActionError('Name is required.')
          log.push(`${user.email}:${String(name)}`)
          const redirect = form.get('redirect')
          return {
            notice: `Renamed to ${String(name)}.`,
            redirect: typeof redirect === 'string' ? redirect : undefined,
          }
        },
      })
      cms.admin.action({
        name: 'crash',
        capability: 'shop.manage',
        handler: () => {
          throw new Error('password=hunter2 in a driver error')
        },
      })
    },
  })
}

const RENAME = '/api/p/shop/actions/rename'
const REFERER = { referer: `${ORIGIN}/admin/shop/products?page=2` }

describe('admin pages', () => {
  it('resolves pages under /admin/{pluginId} for users with the capability', async () => {
    const kernel = await bootKernel({ plugins: [shopPlugin()] })
    const { user } = await signIn(kernel, 'shop_manager')

    const page = await kernel.resolveAdminPage('/admin/shop/orders/7', { tab: 'x' }, user)
    expect(page).toMatchObject({
      kind: 'page',
      key: 'shop.order',
      pluginId: 'shop',
      title: 'Order 7',
      props: { params: { id: '7' }, searchParams: { tab: 'x' }, data: '7', user },
    })
    expect(await kernel.resolveAdminPage('/admin/shop/orders/missing', {}, user)).toEqual({
      kind: 'not-found',
    })
    expect(await kernel.resolveAdminPage('/admin/shop/nothing', {}, user)).toEqual({
      kind: 'not-found',
    })
    expect(kernel.adminUrl('shop.order', { id: 'a b' })).toBe('/admin/shop/orders/a%20b')
  })

  it('forbids users without admin access or without the page capability', async () => {
    const kernel = await bootKernel({ plugins: [shopPlugin()] })
    for (const role of ['customer', 'support']) {
      const { user } = await signIn(kernel, role)
      expect(await kernel.resolveAdminPage('/admin/shop/orders', {}, user)).toEqual({
        kind: 'forbidden',
      })
    }
  })

  it('builds the menu from pages the user may open, in order', async () => {
    const kernel = await bootKernel({ plugins: [shopPlugin()] })
    const admin = await signIn(kernel)
    expect(kernel.adminMenu(admin.user)).toEqual([
      {
        pluginId: 'shop',
        label: 'Shop',
        items: [
          { key: 'shop.products', label: 'Products', url: '/admin/shop/products' },
          { key: 'shop.orders', label: 'Orders', url: '/admin/shop/orders' },
        ],
      },
    ])
    expect(kernel.adminMenu((await signIn(kernel, 'support')).user)).toEqual([])
    expect(kernel.adminMenu((await signIn(kernel, 'customer')).user)).toEqual([])
  })

  it('rejects menu pages with parameters and warns about undeclared capabilities', async () => {
    const withParams = plugin('bad', {
      setup: (cms) =>
        cms.admin.page({
          name: 'item',
          path: '/items/:id',
          title: 'Item',
          capability: 'core.access_admin',
          menu: { label: 'Item' },
          component: () => null,
        }),
    })
    await expect(bootKernel({ plugins: [withParams] })).rejects.toThrow(
      'Admin page "bad.item" has parameters, so it cannot be in the menu',
    )

    const undeclared = plugin('shop', {
      setup: (cms) =>
        cms.admin.page({
          name: 'secret',
          path: '/secret',
          title: 'Secret',
          capability: 'shop.undeclared',
          component: () => null,
        }),
    })
    const kernel = await bootKernel({ plugins: [undeclared] })
    expect(kernel.warnings).toContain(
      'Admin page "shop.secret" requires undeclared capability "shop.undeclared"; only administrators can use it',
    )
  })
})

describe('admin actions', () => {
  it('runs the handler as the signed-in user and redirects back with a signed notice', async () => {
    const log: string[] = []
    const kernel = await bootKernel({ plugins: [shopPlugin(log)] })
    const { user, cookie } = await signIn(kernel, 'shop_manager')

    const response = await kernel.handleApi(
      formPost(RENAME, { name: 'Mugs' }, { cookie, ...REFERER }),
    )
    expect(redirectOf(kernel, response)).toEqual({
      status: 303,
      path: '/admin/shop/products?page=2',
      flash: { kind: 'notice', message: 'Renamed to Mugs.' },
    })
    expect(log).toEqual([`${user.email}:Mugs`])
  })

  it('follows same-site redirects only', async () => {
    const kernel = await bootKernel({ plugins: [shopPlugin()] })
    const { cookie } = await signIn(kernel)
    const post = (redirect: string) =>
      kernel.handleApi(formPost(RENAME, { name: 'x', redirect }, { cookie, ...REFERER }))

    expect(redirectOf(kernel, await post('/admin/shop/orders')).path).toBe('/admin/shop/orders')
    for (const evil of [
      'https://evil.test/x',
      '//evil.test/x',
      '/\\evil.test',
      'javascript:alert(1)',
    ]) {
      expect(redirectOf(kernel, await post(evil)).path).toBe('/admin/shop/products?page=2')
    }
  })

  it('sends the user back with the message of an ActionError', async () => {
    const kernel = await bootKernel({ plugins: [shopPlugin()] })
    const { cookie } = await signIn(kernel)
    const response = await kernel.handleApi(formPost(RENAME, {}, { cookie, ...REFERER }))
    expect(redirectOf(kernel, response)).toEqual({
      status: 303,
      path: '/admin/shop/products?page=2',
      flash: { kind: 'error', message: 'Name is required.' },
    })
  })

  it('logs unexpected errors and shows a generic message', async () => {
    const logger = { entries: [] as { message: string; context?: Record<string, unknown> }[] }
    const kernel = await bootKernel({
      plugins: [shopPlugin()],
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (message, context) => void logger.entries.push({ message, context }),
      },
    })
    const { cookie } = await signIn(kernel)
    const response = await kernel.handleApi(
      formPost('/api/p/shop/actions/crash', {}, { cookie, ...REFERER }),
    )
    const { flash } = redirectOf(kernel, response)
    expect(flash).toEqual({ kind: 'error', message: 'Something went wrong. Check the server log.' })
    expect(response.headers.get('location')).not.toContain('hunter2')
    expect(logger.entries).toMatchObject([
      { message: 'Admin action failed', context: { plugin: 'shop', action: 'crash' } },
    ])
  })

  it('redirects signed-out users to the login page and back afterwards', async () => {
    const kernel = await bootKernel({ plugins: [shopPlugin()] })
    const response = await kernel.handleApi(formPost(RENAME, { name: 'x' }, REFERER))
    expect(redirectOf(kernel, response)).toMatchObject({
      status: 303,
      path: `/admin/login?next=${encodeURIComponent('/admin/shop/products?page=2')}`,
    })
  })

  it('refuses users without the capability', async () => {
    const kernel = await bootKernel({ plugins: [shopPlugin()] })
    const { cookie } = await signIn(kernel, 'support')
    const response = await kernel.handleApi(formPost(RENAME, { name: 'x' }, { cookie }))
    expect(response.status).toBe(403)
  })

  it('requires a same-site Origin and a form body', async () => {
    const kernel = await bootKernel({
      plugins: [shopPlugin()],
      allowedOrigins: ['https://admin.cms.test'],
    })
    const { cookie } = await signIn(kernel)

    const crossSite = formPost(RENAME, { name: 'x' }, { cookie, origin: 'https://evil.test' })
    expect((await kernel.handleApi(crossSite)).status).toBe(403)

    const noOrigin = formPost(RENAME, { name: 'x' }, { cookie })
    noOrigin.headers.delete('origin')
    expect((await kernel.handleApi(noOrigin)).status).toBe(403)

    const allowed = formPost(RENAME, { name: 'x' }, { cookie, origin: 'https://admin.cms.test' })
    expect((await kernel.handleApi(allowed)).status).toBe(303)

    const json = new Request(`${ORIGIN}${RENAME}`, {
      method: 'POST',
      headers: { origin: ORIGIN, cookie, 'content-type': 'application/json' },
      body: '{"name":"x"}',
    })
    expect((await kernel.handleApi(json)).status).toBe(415)
  })
})
