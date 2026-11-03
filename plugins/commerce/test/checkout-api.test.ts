import { TEST_ORIGIN } from '@otwdesign/testing'
import { describe, expect, it } from 'vitest'
import { bootShop, capturingGateway } from './fixtures'

const CHECKOUT = '/api/p/commerce/checkout'

describe('POST /api/p/commerce/checkout', () => {
  it('returns 201 with the order and payment for JSON clients', async () => {
    const shop = await bootShop()
    const response = await shop.request('POST', CHECKOUT, {
      json: {
        email: 'a@b.co',
        gateway: 'manual',
        lines: [{ type: 'product', id: shop.mug.id, quantity: 1 }],
      },
    })
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      order: { number: 1001, status: 'pending', total: 1800, currency: 'USD' },
      payment: { type: 'none' },
    })
  })

  it('redirects an HTML form post to the order received page', async () => {
    const shop = await bootShop()
    const response = await shop.request('POST', CHECKOUT, {
      form: {
        email: 'a@b.co',
        gateway: 'manual',
        item_type: 'product',
        item_id: shop.mug.id,
        quantity: '2',
      },
    })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toMatch(/^\/order\/[0-9a-f-]{36}\/received$/)
  })

  it('redirects a form post to the gateway when it needs one', async () => {
    const gateway = capturingGateway({ type: 'redirect', url: 'https://pay.test/s/9' })
    const shop = await bootShop([gateway.plugin], {
      settings: { 'site.url': 'https://www.shop.test/' },
    })
    const response = await shop.request('POST', CHECKOUT, {
      form: { email: 'a@b.co', gateway: 'test', item_type: 'product', item_id: shop.mug.id },
    })
    expect(response.headers.get('location')).toBe('https://pay.test/s/9')
    expect(gateway.calls[0]!.urls.cancel).toBe('https://www.shop.test/shop')
  })

  it('rejects malformed JSON and invalid fields with 400', async () => {
    const shop = await bootShop()
    const malformed = await shop.request('POST', CHECKOUT, {
      body: '{"email":',
      headers: { 'content-type': 'application/json' },
    })
    expect(malformed.status).toBe(400)

    const invalid = await shop.request('POST', CHECKOUT, {
      json: {
        email: 'nope',
        gateway: 'manual',
        lines: [{ type: 'product', id: shop.mug.id, quantity: 1 }],
      },
    })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ details: { email: expect.any(Array) } })
  })

  it('maps commerce errors to statuses for JSON clients', async () => {
    const shop = await bootShop()
    const response = await shop.request('POST', CHECKOUT, {
      json: {
        email: 'a@b.co',
        gateway: 'paypal',
        lines: [{ type: 'product', id: shop.mug.id, quantity: 1 }],
      },
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'That payment method is not available' })
  })

  it('sends a failed form back to the page it came from with an error code', async () => {
    const shop = await bootShop()
    const response = await shop.request('POST', CHECKOUT, {
      form: { email: 'nope', gateway: 'manual', item_type: 'product', item_id: shop.mug.id },
      headers: { referer: `${TEST_ORIGIN}/product/mug?ref=home` },
    })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe(
      '/product/mug?ref=home&checkout_error=invalid_input',
    )
  })

  it('never redirects a failed form to another site', async () => {
    const shop = await bootShop()
    const response = await shop.request('POST', CHECKOUT, {
      form: { email: 'a@b.co', gateway: 'manual', item_type: 'product', item_id: 'missing' },
      headers: { referer: 'https://evil.test/phish' },
    })
    expect(response.headers.get('location')).toBe('/shop?checkout_error=unknown_item')
  })

  it('blocks cross-site form posts', async () => {
    const shop = await bootShop()
    const response = await shop.request('POST', CHECKOUT, {
      form: { email: 'a@b.co', gateway: 'manual', item_type: 'product', item_id: shop.mug.id },
      headers: { origin: 'https://evil.test' },
    })
    expect(response.status).toBe(403)
  })
})
