import type { SlotComponent } from '@otw/sdk'
import { sql } from 'drizzle-orm'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { bootShop, line } from './fixtures'

const BASE = { baseUrl: 'https://shop.test' }

describe('an account’s orders', () => {
  it('are those placed with its address, listed newest first', async () => {
    const shop = await bootShop()
    const lines = [line(shop.mug.id)]
    await shop.commerce.checkout({ email: 'Ana@Example.com', gateway: 'manual', lines }, BASE)
    await shop.commerce.checkout({ email: 'bo@example.com', gateway: 'manual', lines }, BASE)
    await shop.commerce.checkout({ email: 'ana@example.com', gateway: 'manual', lines }, BASE)
    const { orders, total } = await shop.commerce.listOrders({ email: ' ANA@example.com ' })
    expect(total).toBe(2)
    expect(orders.map((order) => order.number)).toEqual([1003, 1001])
  })

  it('show on the account page once its address is proven, and not before', async () => {
    const shop = await bootShop()
    const { user } = await shop.signIn('customer')
    const lines = [line(shop.mug.id, 2)]
    await shop.commerce.checkout({ email: user.email, gateway: 'manual', lines }, BASE)
    const [section] = shop.kernel.slot('account.sections') as SlotComponent<'account.sections'>[]
    const render = async () => renderToStaticMarkup((await section!({ user })) as ReactElement)

    // Anyone can type an address at checkout: an unproven account sees none of its orders.
    const unproven = await render()
    expect(unproven).toContain('once you’ve confirmed your email address')
    expect(unproven).not.toContain('#1001')

    await shop.db.execute(sql`UPDATE cms_users SET email_verified_at = now()`)
    const proven = await render()
    expect(proven).toContain('#1001')
    expect(proven).toContain('$36.00')
    expect(proven).toContain('Awaiting payment')
  })
})
