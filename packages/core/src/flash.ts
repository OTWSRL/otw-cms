import { createHmac, timingSafeEqual } from 'node:crypto'

export interface Flash {
  kind: 'notice' | 'error'
  message: string
}

export interface FlashCodec {
  encode(flash: Flash): string
  /** `null` for anything not signed by this site in the last few minutes. */
  decode(value: string | string[] | undefined): Flash | null
}

/** Query parameter that carries the one-time message after an admin form redirects. */
export const FLASH_PARAM = 'flash'

const MAX_AGE_MS = 10 * 60 * 1000
const CLOCK_SKEW_MS = 60 * 1000
const MAX_MESSAGE_LENGTH = 300
const MAX_ENCODED_LENGTH = 1000

/**
 * Messages travel in the redirect URL, signed, so a crafted link can't make the admin display
 * attacker-chosen text ("your session expired, call this number").
 */
export function createFlashCodec(secret: string, now: () => number = Date.now): FlashCodec {
  const sign = (payload: string) => createHmac('sha256', secret).update(payload).digest()

  return {
    encode(flash) {
      const payload = Buffer.from(
        JSON.stringify({ k: flash.kind, m: flash.message.slice(0, MAX_MESSAGE_LENGTH), t: now() }),
      ).toString('base64url')
      return `${payload}.${sign(payload).toString('base64url')}`
    },

    decode(value) {
      if (typeof value !== 'string' || value.length > MAX_ENCODED_LENGTH) return null
      const [payload, signature, ...rest] = value.split('.')
      if (!payload || !signature || rest.length > 0) return null
      const expected = sign(payload)
      const actual = Buffer.from(signature, 'base64url')
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null

      let data: unknown
      try {
        data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
      } catch {
        return null
      }
      const { k, m, t } = (data ?? {}) as { k?: unknown; m?: unknown; t?: unknown }
      if ((k !== 'notice' && k !== 'error') || typeof m !== 'string' || typeof t !== 'number') {
        return null
      }
      const age = now() - t
      if (age > MAX_AGE_MS || age < -CLOCK_SKEW_MS) return null
      return { kind: k, message: m }
    },
  }
}

/** Sets (or clears) the flash parameter on a same-site path. */
export function withFlash(path: string, encoded: string | null): string {
  const url = new URL(path, 'http://local')
  url.searchParams.delete(FLASH_PARAM)
  if (encoded) url.searchParams.set(FLASH_PARAM, encoded)
  return url.pathname + url.search + url.hash
}
