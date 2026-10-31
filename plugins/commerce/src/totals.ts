import { CommerceError } from './errors'
import type { CartTotals, Money, QuotedLine } from './types'

export function subtotalOf(lines: readonly QuotedLine[]): Money {
  return lines.reduce((sum, line) => sum + line.lineTotal, 0)
}

/**
 * Filters may only contribute adjustments. Subtotal and total are recomputed here so a buggy
 * or malicious plugin can't produce an order whose numbers don't add up.
 */
export function settleTotals(subtotal: Money, filtered: CartTotals): CartTotals {
  if (!Array.isArray(filtered?.adjustments)) {
    throw new CommerceError('invalid_total', 'A cart totals filter returned no adjustments list')
  }
  const adjustments = filtered.adjustments.map((adjustment) => {
    const { code, label, amount } = adjustment ?? {}
    if (
      typeof code !== 'string' ||
      code === '' ||
      typeof label !== 'string' ||
      !Number.isSafeInteger(amount)
    ) {
      throw new CommerceError(
        'invalid_total',
        `Invalid cart adjustment: ${JSON.stringify(adjustment)}`,
      )
    }
    return { code, label, amount }
  })
  const total = adjustments.reduce((sum, adjustment) => sum + adjustment.amount, subtotal)
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new CommerceError('invalid_total', 'The order total cannot be negative')
  }
  return { subtotal, adjustments, total }
}

export function createMoneyFormatter(currency: string, locale: string): (amount: Money) => string {
  const format = new Intl.NumberFormat(locale, { style: 'currency', currency })
  const divisor = 10 ** currencyDigits(currency)
  return (amount) => format.format(amount / divisor)
}

/** Minor-unit digits: 2 for USD, 0 for JPY. */
export function currencyDigits(currency: string): number {
  return (
    new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits ?? 2
  )
}

/**
 * Parses an amount typed in major units ("18", "18.5", "18.50") into minor units. Digits and an
 * optional decimal point only: "1,800" is ambiguous across locales, so it is rejected.
 */
export function parseMoney(input: string, currency: string): Money | null {
  const digits = currencyDigits(currency)
  const text = input.trim()
  const pattern = digits === 0 ? /^\d{1,12}$/ : new RegExp(`^\\d{1,12}(?:\\.\\d{1,${digits}})?$`)
  if (!pattern.test(text)) return null
  const [whole = '0', fraction = ''] = text.split('.')
  return Number(whole) * 10 ** digits + Number(fraction.padEnd(digits, '0'))
}

/** The inverse of `parseMoney`, for pre-filling a form field. */
export function toMoneyInput(amount: Money, currency: string): string {
  const digits = currencyDigits(currency)
  if (digits === 0) return String(amount)
  const divisor = 10 ** digits
  return `${Math.floor(amount / divisor)}.${String(amount % divisor).padStart(digits, '0')}`
}
