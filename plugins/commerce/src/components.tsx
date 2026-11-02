import type { CommerceErrorCode } from './errors'
import type { Money, Order, OrderStatus, OrderSummary, PaymentGateway, Product } from './types'

type Format = (amount: Money) => string

const STATUS_LABELS: Record<OrderStatus, string> = {
  pending: 'Awaiting payment',
  paid: 'Paid',
  cancelled: 'Cancelled',
}

const ERROR_MESSAGES: Partial<Record<CommerceErrorCode, string>> = {
  invalid_input: 'Please check your email address and quantity.',
  unknown_gateway: 'That payment method is no longer available.',
  unknown_item: 'This item is no longer available.',
  payment_failed: 'We could not reach the payment provider. Please try again.',
}

export function ShopPage({
  products,
  productUrl,
  format,
}: {
  products: Product[]
  productUrl: (product: Product) => string
  format: Format
}) {
  return (
    <section className="commerce-shop">
      <h1>Shop</h1>
      {products.length === 0 ? (
        <p>No products yet.</p>
      ) : (
        <ul className="commerce-grid">
          {products.map((product) => (
            <li key={product.id} className="commerce-card">
              <a href={productUrl(product)}>
                <h2>{product.title}</h2>
                <p className="commerce-price">{format(product.price)}</p>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function ProductPage({
  product,
  gateways,
  checkoutUrl,
  format,
  error,
}: {
  product: Product
  gateways: PaymentGateway[]
  checkoutUrl: string
  format: Format
  error: string | undefined
}) {
  const message = error
    ? (ERROR_MESSAGES[error as CommerceErrorCode] ?? 'Something went wrong. Please try again.')
    : null
  return (
    <article className="commerce-product">
      <h1>{product.title}</h1>
      <p className="commerce-price">{format(product.price)}</p>
      {product.description && <p>{product.description}</p>}

      {message && (
        <p role="alert" className="commerce-error">
          {message}
        </p>
      )}

      {gateways.length === 0 ? (
        <p>Checkout is not available right now.</p>
      ) : (
        <form method="post" action={checkoutUrl} className="commerce-checkout">
          <input type="hidden" name="item_type" value="product" />
          <input type="hidden" name="item_id" value={product.id} />
          <label>
            Email
            <input type="email" name="email" required autoComplete="email" />
          </label>
          <label>
            Quantity
            <input type="number" name="quantity" min={1} max={99} defaultValue={1} required />
          </label>
          <fieldset>
            <legend>Payment method</legend>
            {gateways.map((gateway, index) => (
              <label key={gateway.id}>
                <input
                  type="radio"
                  name="gateway"
                  value={gateway.id}
                  defaultChecked={index === 0}
                  required
                />
                {gateway.label}
                {gateway.description && <small> — {gateway.description}</small>}
              </label>
            ))}
          </fieldset>
          <button type="submit">Place order</button>
        </form>
      )}
    </article>
  )
}

/**
 * The account page's Orders, as WooCommerce's My Account › Orders: those placed with the
 * account's address, once the person has proved it is theirs. Until then, saying so, since
 * anyone can type an address at checkout.
 */
export function AccountOrders({
  orders,
  verified,
  format,
  orderUrl,
}: {
  orders: readonly OrderSummary[]
  verified: boolean
  format: Format
  orderUrl(order: OrderSummary): string
}) {
  return (
    <section className="commerce-account-orders" aria-labelledby="account-orders">
      <h2 id="account-orders">Orders</h2>
      {!verified ? (
        <p>
          Your orders show here once you’ve confirmed your email address. To confirm it, set a new
          password from the link “Lost your password?” emails you.
        </p>
      ) : orders.length === 0 ? (
        <p>No orders yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Order</th>
              <th scope="col">Date</th>
              <th scope="col">Status</th>
              <th scope="col">Total</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <tr key={order.id}>
                <td>
                  <a href={orderUrl(order)}>#{order.number}</a>
                </td>
                <td>
                  <time dateTime={order.createdAt.toISOString()}>
                    {order.createdAt.toISOString().slice(0, 10)}
                  </time>
                </td>
                <td>{STATUS_LABELS[order.status]}</td>
                <td>{format(order.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

export function OrderReceivedPage({ order, format }: { order: Order; format: Format }) {
  return (
    <article className="commerce-order">
      <h1>Order #{order.number}</h1>
      <p>
        Status: <strong data-testid="order-status">{STATUS_LABELS[order.status]}</strong>
      </p>
      <table>
        <tbody>
          {order.lines.map((line) => (
            <tr key={`${line.itemType}:${line.itemId}`}>
              <td>
                {line.title} × {line.quantity}
              </td>
              <td>{format(line.unitPrice * line.quantity)}</td>
            </tr>
          ))}
          {order.adjustments.map((adjustment) => (
            <tr key={adjustment.code}>
              <td>{adjustment.label}</td>
              <td>{format(adjustment.amount)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th>Total</th>
            <th data-testid="order-total">{format(order.total)}</th>
          </tr>
        </tfoot>
      </table>
    </article>
  )
}
