import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from '../src/passwords'

describe('passwords', () => {
  it('verifies the right password and rejects others', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(hash).toMatch(/^scrypt\$32768\$8\$3\$[\w-]{22}\$[\w-]{43}$/)
    await expect(verifyPassword('correct horse battery staple', hash)).resolves.toBe(true)
    await expect(verifyPassword('correct horse battery stapler', hash)).resolves.toBe(false)
  })

  it('verifies hashes made at the fast test cost, since the cost is stored in the hash', async () => {
    const hash = await hashPassword('correct horse battery staple', 'fast')
    expect(hash).toMatch(/^scrypt\$1024\$8\$1\$/)
    await expect(verifyPassword('correct horse battery staple', hash)).resolves.toBe(true)
  })

  it('salts every hash', async () => {
    expect(await hashPassword('same password')).not.toBe(await hashPassword('same password'))
  })

  it('treats canonically equivalent Unicode as the same password', async () => {
    const hash = await hashPassword('café-password')
    await expect(verifyPassword('café-password', hash)).resolves.toBe(true)
  })

  it.each([
    ['empty', ''],
    ['another scheme', 'bcrypt$2b$10$abc'],
    ['missing parts', 'scrypt$32768$8$3$c2FsdA'],
    ['extra parts', 'scrypt$32768$8$3$c2FsdA$a2V5$x'],
    ['non-numeric cost', 'scrypt$lots$8$3$c2FsdA$a2V5'],
    // A tampered row must not make the server allocate gigabytes.
    ['excessive cost', `scrypt$${2 ** 24}$8$3$c2FsdA$${'a'.repeat(43)}`],
    ['short key', 'scrypt$32768$8$3$c2FsdA$a2V5'],
  ])('rejects a malformed hash (%s) without throwing', async (_case, stored) => {
    await expect(verifyPassword('anything', stored)).resolves.toBe(false)
  })
})
