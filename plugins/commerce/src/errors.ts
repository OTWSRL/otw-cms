export type CommerceErrorCode =
  | 'invalid_input'
  | 'unknown_gateway'
  | 'unknown_item'
  | 'invalid_total'
  | 'payment_failed'
  | 'order_not_found'
  | 'product_not_found'
  | 'payment_mismatch'
  | 'invalid_state'

export class CommerceError extends Error {
  readonly code: CommerceErrorCode

  constructor(code: CommerceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CommerceError'
    this.code = code
  }
}
