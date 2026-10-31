import type { PluginContext, SearchParams } from '@cms/sdk'
import { ActionError } from '@cms/sdk'
import type { ReactNode } from 'react'
import { CommerceError } from './errors'
import { currencyDigits, toMoneyInput } from './totals'
import type { CommerceService, Money, Order, OrderStatus, OrderSummary, Product } from './types'

type Format = (amount: Money) => string

const PAGE_SIZE = 25
const STATUSES: readonly OrderStatus[] = ['pending', 'paid', 'cancelled']
const STATUS_LABELS: Record<OrderStatus, string> = {
  pending: 'Awaiting payment',
  paid: 'Paid',
  cancelled: 'Cancelled',
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function field(form: FormData, name: string): string {
  const value = form.get(name)
  return typeof value === 'string' ? value : ''
}

/** Turns domain errors the admin can fix into form errors; anything else is a bug and is logged. */
async function asActionError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof CommerceError) throw new ActionError(`${error.message}.`)
    throw error
  }
}

export function ordersQuery(searchParams: SearchParams) {
  const status = first(searchParams.status)
  const page = Number.parseInt(first(searchParams.page) ?? '1', 10)
  return {
    status: STATUSES.includes(status as OrderStatus) ? (status as OrderStatus) : undefined,
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
  }
}

export function registerAdmin(
  cms: PluginContext,
  commerce: CommerceService,
  manualGatewayId: string,
): void {
  const format = commerce.formatMoney

  registerCapabilities(cms, manualGatewayId)
  registerSettings(cms)
  registerDashboard(cms, commerce)

  cms.admin.page({
    name: 'products',
    path: '/products',
    title: 'Products',
    capability: 'commerce.manage_products',
    menu: { label: 'Products', order: 10 },
    load: () => commerce.listProducts(),
    component: ({ data }) => (
      <ProductsAdmin
        products={data}
        format={format}
        newUrl={cms.admin.url('commerce.product-new')}
        editUrl={(product) => cms.admin.url('commerce.product', { id: product.id })}
      />
    ),
  })

  cms.admin.page({
    name: 'product-new',
    path: '/products/new',
    title: 'Add product',
    capability: 'commerce.manage_products',
    component: () => (
      <ProductForm
        currency={commerce.currency}
        actionUrl={cms.admin.actionUrl('save-product')}
        listUrl={cms.admin.url('commerce.products')}
      />
    ),
  })

  cms.admin.page({
    name: 'product',
    path: '/products/:id',
    capability: 'commerce.manage_products',
    load: ({ params }) => commerce.getProduct(params.id!),
    title: ({ data }) => data.title,
    component: ({ data }) => (
      <ProductForm
        product={data}
        currency={commerce.currency}
        actionUrl={cms.admin.actionUrl('save-product')}
        listUrl={cms.admin.url('commerce.products')}
        publicUrl={cms.routes.url('commerce.product', { slug: data.slug })}
      />
    ),
  })

  cms.admin.page({
    name: 'orders',
    path: '/orders',
    title: 'Orders',
    capability: 'commerce.manage_orders',
    menu: { label: 'Orders', order: 20 },
    load: async ({ searchParams }) => {
      const query = ordersQuery(searchParams)
      const result = await commerce.listOrders({
        status: query.status,
        limit: PAGE_SIZE,
        offset: (query.page - 1) * PAGE_SIZE,
      })
      return { ...result, ...query }
    },
    component: ({ data }) => (
      <OrdersAdmin
        {...data}
        pages={Math.max(1, Math.ceil(data.total / PAGE_SIZE))}
        format={format}
        listUrl={cms.admin.url('commerce.orders')}
        orderUrl={(order) => cms.admin.url('commerce.order', { id: order.id })}
      />
    ),
  })

  cms.admin.page({
    name: 'order',
    path: '/orders/:id',
    capability: 'commerce.manage_orders',
    load: ({ params }) => commerce.getOrder(params.id!),
    title: ({ data }) => `Order #${data.number}`,
    component: ({ data, user }) => (
      <OrderAdmin
        order={data}
        format={format}
        listUrl={cms.admin.url('commerce.orders')}
        markPaidUrl={
          cms.auth.can(user, 'commerce.mark_order_paid', data)
            ? cms.admin.actionUrl('mark-order-paid')
            : undefined
        }
        cancelUrl={
          cms.auth.can(user, 'commerce.cancel_order', data)
            ? cms.admin.actionUrl('cancel-order')
            : undefined
        }
        panels={cms.slots.get('commerce.admin.order').map((Panel, index) => (
          <Panel key={index} order={data} user={user} />
        ))}
      />
    ),
  })

  cms.admin.action({
    name: 'save-product',
    capability: 'commerce.manage_products',
    async handler({ form }) {
      const price = commerce.parseMoney(field(form, 'price'))
      if (price === null) {
        throw new ActionError('Enter the price as a number, such as 18.50.')
      }
      const input = {
        title: field(form, 'title'),
        slug: field(form, 'slug'),
        description: field(form, 'description'),
        price,
      }
      const id = field(form, 'id')
      if (id) {
        await asActionError(() => commerce.updateProduct(id, input))
        return { notice: 'Product saved.' }
      }
      const product = await asActionError(() => commerce.createProduct(input))
      return {
        notice: 'Product created.',
        redirect: cms.admin.url('commerce.product', { id: product.id }),
      }
    },
  })

  cms.admin.action({
    name: 'mark-order-paid',
    capability: 'commerce.manage_orders',
    async handler({ form, user }) {
      const order = await commerce.getOrder(field(form, 'order'))
      if (!order) throw new ActionError('That order no longer exists.')
      // Paid and cancelled orders go on to the service, which answers "already paid" or refuses.
      if (order.status === 'pending' && !cms.auth.can(user, 'commerce.mark_order_paid', order)) {
        throw new ActionError(`Payments through ${order.gateway} are confirmed by the provider.`)
      }
      const { changed } = await asActionError(() =>
        commerce.markPaid(order.id, {
          gateway: order.gateway,
          // Who confirmed it, for the audit trail; card payments store the provider's id here.
          reference: `manual:${user.id}`,
          amount: order.total,
          currency: order.currency,
        }),
      )
      return { notice: changed ? `Order #${order.number} marked as paid.` : 'Already paid.' }
    },
  })

  cms.admin.action({
    name: 'cancel-order',
    capability: 'commerce.manage_orders',
    async handler({ form, user }) {
      const found = await commerce.getOrder(field(form, 'order'))
      if (!found) throw new ActionError('That order no longer exists.')
      if (found.status === 'pending' && !cms.auth.can(user, 'commerce.cancel_order', found)) {
        throw new ActionError(`Order #${found.number} cannot be cancelled.`)
      }
      const { order, changed } = await asActionError(() => commerce.cancelOrder(found.id))
      return { notice: changed ? `Order #${order.number} cancelled.` : 'Already cancelled.' }
    },
  })
}

function registerCapabilities(cms: PluginContext, manualGatewayId: string): void {
  cms.auth.role('shop_manager', { label: 'Shop manager', capabilities: ['core.access_admin'] })
  cms.auth.capability('commerce.manage_products', {
    label: 'Manage products',
    roles: ['shop_manager'],
  })
  cms.auth.capability('commerce.manage_orders', { label: 'Manage orders', roles: ['shop_manager'] })
  cms.auth.capability('commerce.manage_settings', {
    label: 'Change shop settings',
    roles: ['shop_manager'],
  })
  cms.auth.metaCapability('commerce.mark_order_paid', {
    label: 'Mark an order as paid',
    map: (_user, order) =>
      order.status === 'pending' && order.gateway === manualGatewayId
        ? ['commerce.manage_orders']
        : false,
  })
  cms.auth.metaCapability('commerce.cancel_order', {
    label: 'Cancel an order',
    map: (_user, order) => (order.status === 'pending' ? ['commerce.manage_orders'] : false),
  })
}

/** Settings › Shop and Settings › Payments, which gateway plugins add their sections to. */
function registerSettings(cms: PluginContext): void {
  cms.admin.settingsPage({
    name: 'settings',
    path: '/settings',
    title: 'Shop settings',
    capability: 'commerce.manage_settings',
    menu: { label: 'Shop' },
  })
  cms.admin.settingsSection({
    name: 'store',
    page: 'commerce.settings',
    title: 'Store',
    fields: ['commerce.currency'],
  })
  cms.admin.settingsPage({
    name: 'payments',
    path: '/settings/payments',
    title: 'Payment settings',
    description: 'How customers can pay. Payment plugins add their own sections here.',
    capability: 'commerce.manage_settings',
    menu: { label: 'Payments' },
  })
  cms.admin.settingsSection({
    name: 'pay-later',
    page: 'commerce.payments',
    title: 'Pay later',
    fields: ['commerce.manualGateway'],
  })
}

function registerDashboard(cms: PluginContext, commerce: CommerceService): void {
  cms.slots.fill('admin.dashboard', {
    async component({ user }) {
      if (!cms.auth.can(user, 'commerce.manage_orders')) return null
      const { total } = await commerce.listOrders({ status: 'pending', limit: 1 })
      return (
        <section className="cms-widget" aria-labelledby="widget-commerce-orders">
          <h2 id="widget-commerce-orders">Orders</h2>
          <p>
            <a href={`${cms.admin.url('commerce.orders')}?status=pending`}>
              {total} awaiting payment
            </a>
          </p>
        </section>
      )
    },
  })
}

function ProductsAdmin({
  products,
  format,
  newUrl,
  editUrl,
}: {
  products: Product[]
  format: Format
  newUrl: string
  editUrl: (product: Product) => string
}) {
  return (
    <>
      <p>
        <a className="cms-button" href={newUrl}>
          Add product
        </a>
      </p>
      {products.length === 0 ? (
        <p>No products yet.</p>
      ) : (
        <table className="cms-table">
          <thead>
            <tr>
              <th scope="col">Title</th>
              <th scope="col">Slug</th>
              <th scope="col" className="cms-numeric">
                Price
              </th>
            </tr>
          </thead>
          <tbody>
            {products.map((product) => (
              <tr key={product.id}>
                <td>
                  <a href={editUrl(product)}>{product.title}</a>
                </td>
                <td>
                  <code>{product.slug}</code>
                </td>
                <td className="cms-numeric">{format(product.price)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

function ProductForm({
  product,
  currency,
  actionUrl,
  listUrl,
  publicUrl,
}: {
  product?: Product
  currency: string
  actionUrl: string
  listUrl: string
  publicUrl?: string
}) {
  const digits = currencyDigits(currency)
  return (
    <form method="post" action={actionUrl} className="cms-form">
      {product && <input type="hidden" name="id" value={product.id} />}
      <label>
        Title
        <input name="title" required maxLength={200} defaultValue={product?.title} />
      </label>
      <label>
        Slug
        <input
          name="slug"
          required
          pattern="[a-z0-9]+(-[a-z0-9]+)*"
          defaultValue={product?.slug}
          aria-describedby="slug-help"
        />
        <small id="slug-help">Lowercase letters, digits and dashes. Used in the product URL.</small>
      </label>
      <label>
        Price ({currency})
        <input
          name="price"
          required
          inputMode={digits === 0 ? 'numeric' : 'decimal'}
          pattern={digits === 0 ? '\\d+' : `\\d+(\\.\\d{1,${digits}})?`}
          defaultValue={product ? toMoneyInput(product.price, currency) : undefined}
        />
      </label>
      <label>
        Description
        <textarea
          name="description"
          rows={4}
          maxLength={5000}
          defaultValue={product?.description}
        />
      </label>
      <div className="cms-form-actions">
        <button type="submit" className="cms-button">
          {product ? 'Save product' : 'Create product'}
        </button>
        <a href={listUrl}>Back to products</a>
        {publicUrl && <a href={publicUrl}>View in shop</a>}
      </div>
    </form>
  )
}

function OrdersAdmin({
  orders,
  total,
  status,
  page,
  pages,
  format,
  listUrl,
  orderUrl,
}: {
  orders: OrderSummary[]
  total: number
  status: OrderStatus | undefined
  page: number
  pages: number
  format: Format
  listUrl: string
  orderUrl: (order: OrderSummary) => string
}) {
  const link = (query: { status?: OrderStatus; page?: number }) => {
    const params = new URLSearchParams()
    if (query.status) params.set('status', query.status)
    if (query.page && query.page > 1) params.set('page', String(query.page))
    const search = params.toString()
    return search ? `${listUrl}?${search}` : listUrl
  }
  return (
    <>
      <nav aria-label="Filter orders" className="cms-filters">
        <a href={link({})} aria-current={status === undefined ? 'page' : undefined}>
          All
        </a>
        {STATUSES.map((value) => (
          <a
            key={value}
            href={link({ status: value })}
            aria-current={status === value ? 'page' : undefined}
          >
            {STATUS_LABELS[value]}
          </a>
        ))}
      </nav>
      {orders.length === 0 ? (
        <p>No orders.</p>
      ) : (
        <table className="cms-table">
          <thead>
            <tr>
              <th scope="col">Order</th>
              <th scope="col">Customer</th>
              <th scope="col">Status</th>
              <th scope="col">Placed</th>
              <th scope="col" className="cms-numeric">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <tr key={order.id}>
                <td>
                  <a href={orderUrl(order)}>#{order.number}</a>
                </td>
                <td>{order.email}</td>
                <td>{STATUS_LABELS[order.status]}</td>
                <td>
                  <time dateTime={order.createdAt.toISOString()}>
                    {order.createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC
                  </time>
                </td>
                <td className="cms-numeric">{format(order.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="cms-pagination">
        {total} {total === 1 ? 'order' : 'orders'}
        {page > 1 && <a href={link({ status, page: page - 1 })}>Previous</a>}
        {page < pages && <a href={link({ status, page: page + 1 })}>Next</a>}
      </p>
    </>
  )
}

function OrderAdmin({
  order,
  format,
  listUrl,
  markPaidUrl,
  cancelUrl,
  panels,
}: {
  order: Order
  format: Format
  listUrl: string
  /** Only set when this user may take the action on this order. */
  markPaidUrl?: string
  cancelUrl?: string
  panels: ReactNode[]
}) {
  return (
    <>
      <dl className="cms-details">
        <dt>Status</dt>
        <dd data-testid="admin-order-status">{STATUS_LABELS[order.status]}</dd>
        <dt>Customer</dt>
        <dd>{order.email}</dd>
        <dt>Payment</dt>
        <dd>
          {order.gateway}
          {order.paymentRef && (
            <>
              {' '}
              <code>{order.paymentRef}</code>
            </>
          )}
        </dd>
      </dl>
      <table className="cms-table">
        <tbody>
          {order.lines.map((line) => (
            <tr key={`${line.itemType}:${line.itemId}`}>
              <td>
                {line.title} × {line.quantity}
              </td>
              <td className="cms-numeric">{format(line.unitPrice * line.quantity)}</td>
            </tr>
          ))}
          {order.adjustments.map((adjustment) => (
            <tr key={adjustment.code}>
              <td>{adjustment.label}</td>
              <td className="cms-numeric">{format(adjustment.amount)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Total</th>
            <td className="cms-numeric">{format(order.total)}</td>
          </tr>
        </tfoot>
      </table>
      {panels}
      <div className="cms-form-actions">
        {markPaidUrl && (
          <form method="post" action={markPaidUrl}>
            <input type="hidden" name="order" value={order.id} />
            <button type="submit" className="cms-button">
              Mark as paid
            </button>
          </form>
        )}
        {cancelUrl && (
          <form method="post" action={cancelUrl}>
            <input type="hidden" name="order" value={order.id} />
            <button type="submit" className="cms-button cms-button-danger">
              Cancel order
            </button>
          </form>
        )}
        <a href={listUrl}>Back to orders</a>
      </div>
    </>
  )
}
