import { describe, expect, it } from 'vitest'
import { createFlashCodec, withFlash } from '../src/flash'

describe('flash messages', () => {
  const clock = { now: 1_000_000 }
  const codec = createFlashCodec('secret-a', () => clock.now)

  it('round-trips a signed message', () => {
    const encoded = codec.encode({ kind: 'notice', message: 'Saved <b>' })
    expect(encoded).toMatch(/^[\w-]+\.[\w-]+$/)
    expect(codec.decode(encoded)).toEqual({ kind: 'notice', message: 'Saved <b>' })
  })

  it('rejects messages signed with another secret or tampered with', () => {
    const encoded = codec.encode({ kind: 'error', message: 'Nope' })
    expect(createFlashCodec('secret-b', () => clock.now).decode(encoded)).toBeNull()

    const [, signature] = encoded.split('.')
    const forged = Buffer.from(JSON.stringify({ k: 'error', m: 'Call +1 555', t: clock.now }))
    expect(codec.decode(`${forged.toString('base64url')}.${signature}`)).toBeNull()
  })

  it.each([undefined, '', 'x', 'a.b.c', ['a', 'b'], 'a'.repeat(2000)])(
    'ignores malformed input %#',
    (value) => {
      expect(codec.decode(value as string)).toBeNull()
    },
  )

  it('expires after ten minutes', () => {
    const encoded = codec.encode({ kind: 'notice', message: 'Saved' })
    clock.now += 10 * 60 * 1000 + 1
    expect(codec.decode(encoded)).toBeNull()
    clock.now = 1_000_000
  })

  it('caps the message length', () => {
    const encoded = codec.encode({ kind: 'notice', message: 'x'.repeat(1000) })
    expect(codec.decode(encoded)?.message).toHaveLength(300)
  })
})

describe('withFlash', () => {
  it('replaces an earlier flash and keeps the rest of the query', () => {
    expect(withFlash('/admin/plugins?tab=all&flash=old', 'new')).toBe(
      '/admin/plugins?tab=all&flash=new',
    )
    expect(withFlash('/admin?flash=old', null)).toBe('/admin')
  })
})
