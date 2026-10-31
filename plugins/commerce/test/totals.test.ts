import { describe, expect, it } from 'vitest'
import { CommerceError } from '../src/errors'
import { createMoneyFormatter, parseMoney, settleTotals, toMoneyInput } from '../src/totals'

describe('settleTotals', () => {
  it('recomputes the total from the subtotal and adjustments', () => {
    const totals = settleTotals(1000, {
      subtotal: 999_999,
      total: 1,
      adjustments: [
        { code: 'TEN', label: '10% off', amount: -100 },
        { code: 'SHIP', label: 'Shipping', amount: 500 },
      ],
    })
    expect(totals).toEqual({
      subtotal: 1000,
      total: 1400,
      adjustments: [
        { code: 'TEN', label: '10% off', amount: -100 },
        { code: 'SHIP', label: 'Shipping', amount: 500 },
      ],
    })
  })

  it.each([
    [{ subtotal: 1000, total: 1000 } as never, 'no adjustments list'],
    [
      { subtotal: 1000, total: 0, adjustments: [{ code: 'X', label: 'X', amount: 1.5 }] },
      'Invalid cart adjustment',
    ],
    [
      { subtotal: 1000, total: 0, adjustments: [{ code: '', label: 'X', amount: 1 }] },
      'Invalid cart adjustment',
    ],
    [{ subtotal: 1000, total: 0, adjustments: [null as never] }, 'Invalid cart adjustment'],
    [
      {
        subtotal: 1000,
        total: 0,
        adjustments: [{ code: 'BIG', label: 'Too much', amount: -1001 }],
      },
      'cannot be negative',
    ],
  ])('rejects %j', (filtered, message) => {
    expect(() => settleTotals(1000, filtered)).toThrow(message)
    expect(() => settleTotals(1000, filtered)).toThrow(CommerceError)
  })

  it('allows a fully discounted order', () => {
    expect(
      settleTotals(1000, {
        subtotal: 1000,
        total: 0,
        adjustments: [{ code: 'FREE', label: 'Free', amount: -1000 }],
      }).total,
    ).toBe(0)
  })
})

describe('createMoneyFormatter', () => {
  it('formats minor units for the currency', () => {
    expect(createMoneyFormatter('USD', 'en-US')(1999)).toBe('$19.99')
    expect(createMoneyFormatter('JPY', 'en-US')(1999)).toBe('¥1,999')
    expect(createMoneyFormatter('EUR', 'de-DE')(123456)).toBe('1.234,56 €')
  })
})

describe('parseMoney', () => {
  it.each([
    ['18', 'USD', 1800],
    ['18.5', 'USD', 1850],
    [' 18.50 ', 'USD', 1850],
    ['0.99', 'USD', 99],
    ['1999', 'JPY', 1999],
    ['12.345', 'KWD', 12345],
  ])('reads %j %s as %i minor units', (input, currency, expected) => {
    expect(parseMoney(input, currency)).toBe(expected)
  })

  it.each([
    ['', 'USD'],
    ['18.505', 'USD'],
    ['1,800', 'USD'],
    ['-1', 'USD'],
    ['.5', 'USD'],
    ['1e3', 'USD'],
    ['18.5', 'JPY'],
    ['1234567890123', 'USD'],
  ])('rejects %j in %s', (input, currency) => {
    expect(parseMoney(input, currency)).toBeNull()
  })

  it('formats minor units back for a form field', () => {
    expect(toMoneyInput(1850, 'USD')).toBe('18.50')
    expect(toMoneyInput(5, 'USD')).toBe('0.05')
    expect(toMoneyInput(1999, 'JPY')).toBe('1999')
    expect(parseMoney(toMoneyInput(123456, 'KWD'), 'KWD')).toBe(123456)
  })
})
