import { defineAdmin, definePlugin, type User } from '@otwdesign/sdk'
import { TEST_ORIGIN, type TestKernel } from '@otwdesign/testing'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ordersQuery } from '../src/admin'
import { bootShop, capturingGateway, coursesPlugin, line } from './fixtures'

const action = (name: string) => `/api/p/commerce/actions/${name}`

function redirectOf(harness: TestKernel, response: Response) {
  const url = new URL(response.headers.get('location') ?? '', TEST_ORIGIN)
  const flash = harness.kernel.readFlash(url.searchParams.get('flash') ?? undefined)
  url.searchParams.delete('flash')
  return { status: response.status, path: url.pathname + url.search, flash }
}

/** Renders an admin screen's component the way the app does, for assertions on the markup. */
async function renderAdmin(harness: TestKernel, path: string, user: User) {
  const page = await harness.kernel.resolveAdminPage(path, {}, user)
  if (page.kind !== 'page') throw new Error(`Expected a page, got ${page.kind}`)
  return renderToStaticMarkup((await page.Component(page.props)) as ReactElement)
}

/** A gateway for payments confirmed by hand, which extends commerce's rule for that. */
const bankTransfer = definePlugin({
  id: 'bank-transfer',
  version: '1.0.0',
  requires: { commerce: '^1.0.0' },
  setup(cms) {
    cms.registries.get('commerce.gateways').add({
      id: 'bank',
      label: 'Bank transfer',
      createPayment: async () => ({ type: 'none' }),
    })
    cms.auth.extendCapability('commerce.mark_order_paid', (required, _user, order) =>
      order.gateway === 'bank' && order.status === 'pending'
        ? ['commerce.manage_orders']
        : required,
    )
  },
})

async function placeOrder(shop: Awaited<ReturnType<typeof bootShop>>, gateway = 'manual') {
  const { order } = await shop.commerce.checkout(
    { email: 'ana@example.com', gateway, lines: [line(shop.mug.id)] },
    { baseUrl: TEST_ORIGIN },
  )
  return order
}

describe('commerce service: admin operations', () => {
  it('updates products and keeps slugs unique', async () => {
    const shop = await bootShop()
    const updated = await shop.commerce.updateProduct(shop.mug.id, {
      title: ' Big Mug ',
      slug: 'Big-Mug',
      price: 2000,
    })
    expect(updated).toMatchObject({
      title: 'Big Mug',
      slug: 'big-mug',
      price: 2000,
      description: '',
    })
    expect(await shop.commerce.getProduct(shop.mug.id)).toEqual(updated)

    await expect(
      shop.commerce.updateProduct(shop.notebook.id, { title: 'X', slug: 'big-mug', price: 1 }),
    ).rejects.toThrow('Another product already uses that slug')
    await expect(
      shop.commerce.createProduct({ title: 'X', slug: 'notebook', price: 1 }),
    ).rejects.toThrow('Another product already uses that slug')
    await expect(
      shop.commerce.updateProduct('00000000-0000-4000-8000-000000000000', {
        title: 'X',
        slug: 'x',
        price: 1,
      }),
    ).rejects.toMatchObject({ code: 'product_not_found' })
    await expect(
      shop.commerce.createProduct({ title: 'X', slug: 'x', price: 2_147_483_648 }),
    ).rejects.toThrow('Price must be a non-negative integer')
  })

  it('lists orders newest first with filters and paging, without loading lines', async () => {
    const shop = await bootShop()
    const placed = [await placeOrder(shop), await placeOrder(shop), await placeOrder(shop)]
    await shop.commerce.cancelOrder(placed[0]!.id)

    const all = await shop.commerce.listOrders()
    expect(all.total).toBe(3)
    expect(all.orders.map((order) => order.number)).toEqual([1003, 1002, 1001])
    expect(all.orders[0]).not.toHaveProperty('lines')

    const page = await shop.commerce.listOrders({ limit: 1, offset: 1 })
    expect(page.orders.map((order) => order.number)).toEqual([1002])
    expect(page.total).toBe(3)

    const cancelled = await shop.commerce.listOrders({ status: 'cancelled' })
    expect(cancelled).toMatchObject({ total: 1, orders: [{ number: 1001, status: 'cancelled' }] })
  })

  it('cancels pending orders once, telling other plugins, and refuses paid ones', async () => {
    const cancelled: number[] = []
    const listener = definePlugin({
      id: 'cancel-listener',
      version: '1.0.0',
      requires: { commerce: '*' },
      setup: (cms) =>
        cms.hooks.addAction('commerce.order.cancelled', ({ order }) => {
          cancelled.push(order.number)
        }),
    })
    const shop = await bootShop([listener])
    const order = await placeOrder(shop)

    expect(await shop.commerce.cancelOrder(order.id)).toMatchObject({
      changed: true,
      order: { status: 'cancelled' },
    })
    expect(await shop.commerce.cancelOrder(order.id)).toMatchObject({ changed: false })

    const paid = await placeOrder(shop)
    await shop.commerce.markPaid(paid.id, {
      gateway: 'manual',
      reference: 'manual:test',
      amount: paid.total,
      currency: paid.currency,
    })
    await expect(shop.commerce.cancelOrder(paid.id)).rejects.toThrow(
      `Order #${paid.number} is paid and cannot be cancelled`,
    )
    expect(cancelled).toEqual([order.number])
  })

  it('parses the orders screen query defensively', () => {
    expect(ordersQuery({})).toEqual({ status: undefined, page: 1 })
    expect(ordersQuery({ status: 'paid', page: '3' })).toEqual({ status: 'paid', page: 3 })
    expect(ordersQuery({ status: 'deleted', page: '-2' })).toEqual({ status: undefined, page: 1 })
    expect(ordersQuery({ status: ['paid', 'x'], page: 'abc' })).toEqual({ status: 'paid', page: 1 })
  })
})

describe('commerce admin screens', () => {
  it('gives shop managers a Commerce menu and keeps customers out', async () => {
    const shop = await bootShop()
    const manager = await shop.signIn('shop_manager')
    expect(shop.kernel.adminMenu(manager.user)).toEqual([
      {
        id: 'dashboard',
        label: 'Dashboard',
        icon: 'dashboard',
        items: [{ key: 'core.dashboard', label: 'Home', url: '/admin' }],
      },
      {
        id: 'commerce',
        label: 'Commerce',
        icon: 'cart',
        items: [
          { key: 'commerce.products', label: 'Products', url: '/admin/commerce/products' },
          { key: 'commerce.orders', label: 'Orders', url: '/admin/commerce/orders' },
        ],
      },
      {
        id: 'users',
        label: 'Users',
        icon: 'users',
        items: [{ key: 'core.profile', label: 'Profile', url: '/admin/profile' }],
      },
      {
        id: 'settings',
        label: 'Settings',
        icon: 'settings',
        items: [
          { key: 'commerce.settings', label: 'Shop', url: '/admin/commerce/settings' },
          { key: 'commerce.payments', label: 'Payments', url: '/admin/commerce/settings/payments' },
        ],
      },
    ])

    const customer = await shop.signIn('customer')
    expect(
      await shop.kernel.resolveAdminPage('/admin/commerce/products', {}, customer.user),
    ).toEqual({
      kind: 'forbidden',
    })
  })

  it('loads the product and order screens, with 404s for unknown records', async () => {
    const shop = await bootShop()
    const { user } = await shop.signIn('shop_manager')
    const order = await placeOrder(shop)

    expect(
      await shop.kernel.resolveAdminPage(`/admin/commerce/products/${shop.mug.id}`, {}, user),
    ).toMatchObject({ kind: 'page', title: 'Mug', props: { data: { id: shop.mug.id } } })
    expect(
      await shop.kernel.resolveAdminPage('/admin/commerce/products/new', {}, user),
    ).toMatchObject({ kind: 'page', key: 'commerce.product-new' })
    expect(
      await shop.kernel.resolveAdminPage(`/admin/commerce/orders/${order.id}`, {}, user),
    ).toMatchObject({ kind: 'page', title: `Order #${order.number}` })
    expect(
      await shop.kernel.resolveAdminPage('/admin/commerce/orders', { status: 'pending' }, user),
    ).toMatchObject({ kind: 'page', props: { data: { total: 1, status: 'pending', page: 1 } } })

    for (const path of ['/admin/commerce/products/not-a-uuid', '/admin/commerce/orders/x']) {
      expect(await shop.kernel.resolveAdminPage(path, {}, user)).toEqual({ kind: 'not-found' })
    }
  })
})

describe('commerce admin extension points', () => {
  it('lets shop managers change shop settings but not the site’s', async () => {
    const shop = await bootShop()
    const { user, cookie } = await shop.signIn('shop_manager')
    const sections = (key: string) => {
      const page = shop.kernel.settingsPage(key, user)
      return page.kind === 'settings'
        ? page.view.sections.map((section) => [section.title, section.fields.map((f) => f.key)])
        : page.kind
    }
    expect(sections('commerce.settings')).toEqual([['Store', ['commerce.currency']]])
    expect(sections('commerce.payments')).toEqual([['Pay later', ['commerce.manualGateway']]])
    expect(sections('core.general')).toBe('forbidden')

    const response = await shop.request('POST', '/api/p/core/actions/save-settings', {
      cookie,
      form: { page: 'commerce.settings', 'commerce.currency': 'EUR' },
    })
    expect(redirectOf(shop, response).flash).toEqual({ kind: 'notice', message: 'Settings saved.' })
    const next = await shop.reboot()
    expect(next.service('commerce').currency).toBe('EUR')
  })

  it('offers only the order actions this user may take on this order', async () => {
    const gateway = capturingGateway()
    const shop = await bootShop([gateway.plugin])
    const { user } = await shop.signIn('shop_manager')
    const manual = await placeOrder(shop)
    const card = await placeOrder(shop, 'test')

    const manualHtml = await renderAdmin(shop, `/admin/commerce/orders/${manual.id}`, user)
    expect(manualHtml).toContain('Mark as paid')
    expect(manualHtml).toContain('Cancel order')
    const cardHtml = await renderAdmin(shop, `/admin/commerce/orders/${card.id}`, user)
    expect(cardHtml).not.toContain('Mark as paid')
    expect(cardHtml).toContain('Cancel order')

    await shop.commerce.cancelOrder(manual.id)
    const cancelledHtml = await renderAdmin(shop, `/admin/commerce/orders/${manual.id}`, user)
    expect(cancelledHtml).not.toContain('Mark as paid')
    expect(cancelledHtml).not.toContain('Cancel order')
  })

  it('lets a gateway plugin allow confirming its own orders by hand', async () => {
    const shop = await bootShop([bankTransfer])
    const { cookie, user } = await shop.signIn('shop_manager')
    const order = await placeOrder(shop, 'bank')
    expect(await renderAdmin(shop, `/admin/commerce/orders/${order.id}`, user)).toContain(
      'Mark as paid',
    )

    const response = await shop.request('POST', action('mark-order-paid'), {
      cookie,
      form: { order: order.id },
    })
    expect(redirectOf(shop, response).flash).toEqual({
      kind: 'notice',
      message: `Order #${order.number} marked as paid.`,
    })
    expect(await shop.commerce.getOrder(order.id)).toMatchObject({
      status: 'paid',
      gateway: 'bank',
      paymentRef: `manual:${user.id}`,
    })
  })

  it('shows panels other plugins add to the order screen', async () => {
    const notes = definePlugin({
      id: 'order-notes',
      version: '1.0.0',
      requires: { commerce: '^1.0.0' },
    })
    const notesAdmin = defineAdmin(notes, (cms) => {
      cms.slots.fill('commerce.admin.order', {
        component: ({ order, user }) => (
          <aside>
            Note for #{order.number}, seen by {user.email}
          </aside>
        ),
      })
    })
    const shop = await bootShop([notes], { admin: [notesAdmin] })
    const { user } = await shop.signIn('shop_manager')
    const order = await placeOrder(shop)
    expect(await renderAdmin(shop, `/admin/commerce/orders/${order.id}`, user)).toContain(
      `<aside>Note for #${order.number}, seen by ${user.email}</aside>`,
    )
  })

  it('puts an orders widget on the dashboard for users who manage orders', async () => {
    const shop = await bootShop()
    await placeOrder(shop)
    await placeOrder(shop)
    const [widget] = shop.kernel.slot('admin.dashboard')
    const manager = await shop.signIn('shop_manager')
    const html = renderToStaticMarkup((await widget!({ user: manager.user })) as ReactElement)
    expect(html).toContain('href="/admin/commerce/orders?status=pending">2 awaiting payment</a>')

    const customer = await shop.signIn('customer')
    expect(await widget!({ user: customer.user })).toBeNull()
  })
})

describe('commerce admin actions', () => {
  it('creates a product from the form and opens it for editing', async () => {
    const shop = await bootShop()
    const { cookie } = await shop.signIn('shop_manager')
    const response = await shop.request('POST', action('save-product'), {
      cookie,
      form: { title: 'Tea Towel', slug: 'tea-towel', price: '9.5', description: 'Linen' },
      headers: { referer: `${TEST_ORIGIN}/admin/commerce/products/new` },
    })
    const product = await shop.commerce.getProductBySlug('tea-towel')
    expect(product).toMatchObject({ title: 'Tea Towel', price: 950, description: 'Linen' })
    expect(redirectOf(shop, response)).toEqual({
      status: 303,
      path: `/admin/commerce/products/${product!.id}`,
      flash: { kind: 'notice', message: 'Product created.' },
    })
  })

  it('sends the form back with the reason when the input is wrong', async () => {
    const shop = await bootShop()
    const { cookie } = await shop.signIn('shop_manager')
    const save = (form: Record<string, string>) =>
      shop.request('POST', action('save-product'), {
        cookie,
        form,
        headers: { referer: `${TEST_ORIGIN}/admin/commerce/products/${shop.notebook.id}` },
      })

    const badPrice = await save({ id: shop.notebook.id, title: 'N', slug: 'n', price: '12,00' })
    expect(redirectOf(shop, badPrice)).toEqual({
      status: 303,
      path: `/admin/commerce/products/${shop.notebook.id}`,
      flash: { kind: 'error', message: 'Enter the price as a number, such as 18.50.' },
    })

    const taken = await save({ id: shop.notebook.id, title: 'N', slug: 'mug', price: '12' })
    expect(redirectOf(shop, taken).flash).toEqual({
      kind: 'error',
      message: 'Another product already uses that slug.',
    })
    expect(await shop.commerce.getProduct(shop.notebook.id)).toEqual(shop.notebook)
  })

  it('marks a pay-later order paid, which fires order.paid for other plugins', async () => {
    const enrolled: string[] = []
    const shop = await bootShop([coursesPlugin(enrolled)])
    const { cookie, user } = await shop.signIn('shop_manager')
    const { order } = await shop.commerce.checkout(
      { email: 'ana@example.com', gateway: 'manual', lines: [line('nextjs-101', 1, 'course')] },
      { baseUrl: TEST_ORIGIN },
    )

    const response = await shop.request('POST', action('mark-order-paid'), {
      cookie,
      form: { order: order.id },
    })
    expect(redirectOf(shop, response).flash).toEqual({
      kind: 'notice',
      message: `Order #${order.number} marked as paid.`,
    })
    expect(await shop.commerce.getOrder(order.id)).toMatchObject({
      status: 'paid',
      paymentRef: `manual:${user.id}`,
    })
    expect(enrolled).toEqual(['ana@example.com:nextjs-101'])
  })

  it('leaves card payments to the provider', async () => {
    const gateway = capturingGateway()
    const shop = await bootShop([gateway.plugin])
    const { cookie } = await shop.signIn('shop_manager')
    const order = await placeOrder(shop, 'test')
    const response = await shop.request('POST', action('mark-order-paid'), {
      cookie,
      form: { order: order.id },
    })
    expect(redirectOf(shop, response).flash).toEqual({
      kind: 'error',
      message: 'Payments through test are confirmed by the provider.',
    })
    expect((await shop.commerce.getOrder(order.id))?.status).toBe('pending')
  })

  it('cancels a pending order', async () => {
    const shop = await bootShop()
    const { cookie } = await shop.signIn('shop_manager')
    const order = await placeOrder(shop)
    const response = await shop.request('POST', action('cancel-order'), {
      cookie,
      form: { order: order.id },
    })
    expect(redirectOf(shop, response).flash).toEqual({
      kind: 'notice',
      message: `Order #${order.number} cancelled.`,
    })
    expect((await shop.commerce.getOrder(order.id))?.status).toBe('cancelled')
  })

  it('keeps shop managers out of core screens and customers out of commerce', async () => {
    const shop = await bootShop()
    const manager = await shop.signIn('shop_manager')
    const plugins = await shop.request('POST', '/api/p/core/actions/deactivate-plugin', {
      cookie: manager.cookie,
      form: { plugin: 'commerce' },
    })
    expect(plugins.status).toBe(403)

    const customer = await shop.signIn('customer')
    const product = await shop.request('POST', action('save-product'), {
      cookie: customer.cookie,
      form: { title: 'X', slug: 'x', price: '1' },
    })
    expect(product.status).toBe(403)
    expect(await shop.commerce.getProductBySlug('x')).toBeNull()
  })
})
