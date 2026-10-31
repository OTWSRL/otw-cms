import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto'

/** `fast` is for test suites only, like a lowered bcrypt cost in a Rails test environment. */
export type HashCost = 'standard' | 'fast'

// OWASP's scrypt alternative to N=2^17,p=1 that needs 32 MiB instead of 128 MiB per hash.
// Parameters are stored with each hash, so they can be raised later without breaking logins.
const PARAMS: Record<HashCost, { N: number; r: number; p: number }> = {
  standard: { N: 2 ** 15, r: 8, p: 3 },
  fast: { N: 2 ** 10, r: 8, p: 1 },
}
const KEY_LENGTH = 32
const SALT_LENGTH = 16
// 128 * N * r is 32 MiB, which is all of Node's default limit.
const MAX_MEMORY = 64 * 1024 * 1024
const MAX_COST = 2 ** 20

function derive(password: string, salt: Buffer, length: number, options: ScryptOptions) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password.normalize('NFKC'),
      salt,
      length,
      { ...options, maxmem: MAX_MEMORY },
      (error, key) => (error ? reject(error) : resolve(key)),
    )
  })
}

export async function hashPassword(password: string, cost: HashCost = 'standard'): Promise<string> {
  const salt = randomBytes(SALT_LENGTH)
  const key = await derive(password, salt, KEY_LENGTH, PARAMS[cost])
  const { N, r, p } = PARAMS[cost]
  return ['scrypt', N, r, p, salt.toString('base64url'), key.toString('base64url')].join('$')
}

/** False for a wrong password and for a malformed hash; never throws on bad input. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, key, ...rest] = stored.split('$')
  const N = Number(n)
  const blockSize = Number(r)
  const parallelization = Number(p)
  if (scheme !== 'scrypt' || rest.length > 0 || !salt || !key) return false
  if (![N, blockSize, parallelization].every(Number.isSafeInteger) || N > MAX_COST) return false

  const expected = Buffer.from(key, 'base64url')
  if (expected.length !== KEY_LENGTH) return false
  try {
    const actual = await derive(password, Buffer.from(salt, 'base64url'), expected.length, {
      N,
      r: blockSize,
      p: parallelization,
    })
    return timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}
