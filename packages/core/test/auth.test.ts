import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
  createAuthService,
  LOGIN_FAILURE_WINDOW_MS,
  MAX_LOGIN_FAILURES,
  SESSION_TTL_MS,
} from '../src/auth'
import { coreMigrations } from '../src/core-migrations'
import { DatabaseContext } from '../src/database'
import { createDb } from './helpers'

const PASSWORD = 'correct horse battery staple'

async function setup(roles = ['administrator', 'customer', 'editor']) {
  const db = new DatabaseContext(createDb())
  for (const migration of coreMigrations) await migration.up(db.root)
  const clock = { now: new Date('2026-01-01T00:00:00Z') }
  const auth = createAuthService(db, {
    roleExists: (role) => roles.includes(role),
    hashCost: 'fast',
    now: () => clock.now,
  })
  const advance = (ms: number) => {
    clock.now = new Date(clock.now.getTime() + ms)
  }
  return { db, auth, advance }
}

describe('users', () => {
  it('creates users with a normalised email and never exposes the hash', async () => {
    const { auth, db } = await setup()
    const user = await auth.createUser({
      email: '  Ana@Example.COM ',
      name: ' Ana ',
      role: 'editor',
      password: PASSWORD,
    })
    expect(user).toEqual({
      id: expect.any(String),
      email: 'ana@example.com',
      name: 'Ana',
      role: 'editor',
    })
    expect(await auth.listUsers()).toEqual([user])

    const rows = await db.root.execute(sql`SELECT password_hash FROM cms_users`)
    expect(JSON.stringify(rows)).not.toContain(PASSWORD)
  })

  it.each([
    [{ email: 'not-an-email' }, 'Enter a valid email address.'],
    [{ password: 'short' }, 'Passwords need 10 to 200 characters.'],
    [{ password: 'x'.repeat(201) }, 'Passwords need 10 to 200 characters.'],
    [{ name: 'x'.repeat(101) }, 'Names are limited to 100 characters.'],
    [{ role: 'emperor' }, 'There is no "emperor" role.'],
  ])('rejects invalid input %j', async (override, message) => {
    const { auth } = await setup()
    await expect(
      auth.createUser({ email: 'a@b.co', role: 'editor', password: PASSWORD, ...override }),
    ).rejects.toThrow(message)
  })

  it('rejects a duplicate email regardless of case', async () => {
    const { auth } = await setup()
    await auth.createUser({ email: 'a@b.co', role: 'editor', password: PASSWORD })
    await expect(
      auth.createUser({ email: 'A@B.CO', role: 'editor', password: PASSWORD }),
    ).rejects.toMatchObject({ code: 'email_taken' })
  })

  it('creates the first administrator exactly once, even under concurrent setup', async () => {
    const { auth } = await setup()
    const attempts = await Promise.allSettled([
      auth.createFirstAdministrator({ email: 'one@b.co', password: PASSWORD }),
      auth.createFirstAdministrator({ email: 'two@b.co', password: PASSWORD }),
    ])
    expect(attempts.map((attempt) => attempt.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(attempts.find((attempt) => attempt.status === 'rejected')).toMatchObject({
      reason: { code: 'already_set_up' },
    })
    expect((await auth.listUsers()).map((user) => user.role)).toEqual(['administrator'])
  })
})

describe('roles', () => {
  it('changes roles but never demotes the last administrator', async () => {
    const { auth } = await setup()
    const admin = await auth.createFirstAdministrator({ email: 'admin@b.co', password: PASSWORD })
    await expect(auth.setRole(admin.id, 'editor')).rejects.toMatchObject({
      code: 'last_administrator',
    })

    const second = await auth.createUser({
      email: 'second@b.co',
      role: 'editor',
      password: PASSWORD,
    })
    await auth.setRole(second.id, 'administrator')
    await expect(auth.setRole(admin.id, 'editor')).resolves.toMatchObject({ role: 'editor' })
  })

  it('serialises concurrent demotions so one administrator always remains', async () => {
    const { auth } = await setup()
    const a = await auth.createFirstAdministrator({ email: 'a@b.co', password: PASSWORD })
    const b = await auth.createUser({ email: 'b@b.co', role: 'administrator', password: PASSWORD })
    const results = await Promise.allSettled([
      auth.setRole(a.id, 'editor'),
      auth.setRole(b.id, 'editor'),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect((await auth.listUsers()).filter((user) => user.role === 'administrator')).toHaveLength(1)
  })

  it('rejects unknown roles and users', async () => {
    const { auth } = await setup()
    await expect(auth.setRole('not-a-uuid', 'editor')).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      auth.setRole('00000000-0000-4000-8000-000000000000', 'editor'),
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      auth.setRole('00000000-0000-4000-8000-000000000000', 'emperor'),
    ).rejects.toMatchObject({
      code: 'unknown_role',
    })
  })
})

describe('sessions', () => {
  it('signs in, resolves the session and signs out', async () => {
    const { auth } = await setup()
    const created = await auth.createUser({ email: 'ana@b.co', role: 'editor', password: PASSWORD })
    const { user, token } = await auth.signIn(' ANA@b.co', PASSWORD)
    expect(user).toEqual(created)
    expect(token).toMatch(/^[\w-]{43}$/)
    expect(await auth.userForSession(token)).toEqual(created)

    await auth.signOut(token)
    expect(await auth.userForSession(token)).toBeNull()
  })

  it('stores only a hash of the token', async () => {
    const { auth, db } = await setup()
    const user = await auth.createUser({ email: 'ana@b.co', role: 'editor', password: PASSWORD })
    const token = await auth.createSession(user.id)
    const rows = await db.root.execute(sql`SELECT token_hash FROM cms_sessions`)
    expect(JSON.stringify(rows)).not.toContain(token)
  })

  it('expires sessions', async () => {
    const { auth, advance } = await setup()
    const user = await auth.createUser({ email: 'ana@b.co', role: 'editor', password: PASSWORD })
    const token = await auth.createSession(user.id)
    advance(SESSION_TTL_MS + 1)
    expect(await auth.userForSession(token)).toBeNull()
  })

  it.each([null, undefined, '', 'short', 'x'.repeat(43) + '!'])(
    'treats a malformed token (%j) as signed out',
    async (token) => {
      const { auth } = await setup()
      expect(await auth.userForSession(token)).toBeNull()
    },
  )

  it('gives the same answer for an unknown email and a wrong password', async () => {
    const { auth } = await setup()
    await auth.createUser({ email: 'ana@b.co', role: 'editor', password: PASSWORD })
    await expect(auth.signIn('ana@b.co', 'wrong password!')).rejects.toThrow(
      'Incorrect email or password.',
    )
    await expect(auth.signIn('nobody@b.co', PASSWORD)).rejects.toThrow(
      'Incorrect email or password.',
    )
  })

  it('throttles repeated failures for an email, then lets it try again later', async () => {
    const { auth, advance } = await setup()
    await auth.createUser({ email: 'ana@b.co', role: 'editor', password: PASSWORD })
    for (let i = 0; i < MAX_LOGIN_FAILURES; i++) {
      await expect(auth.signIn('ana@b.co', 'wrong password!')).rejects.toMatchObject({
        code: 'invalid_credentials',
      })
    }
    // Even the right password is refused while throttled.
    await expect(auth.signIn('ana@b.co', PASSWORD)).rejects.toMatchObject({ code: 'throttled' })
    await expect(auth.signIn('other@b.co', 'whatever!!')).rejects.toMatchObject({
      code: 'invalid_credentials',
    })

    advance(LOGIN_FAILURE_WINDOW_MS + 1)
    await expect(auth.signIn('ana@b.co', PASSWORD)).resolves.toMatchObject({
      user: { email: 'ana@b.co' },
    })
  })

  it('ends sessions when the user is deleted', async () => {
    const { auth, db } = await setup()
    const user = await auth.createUser({ email: 'ana@b.co', role: 'editor', password: PASSWORD })
    const token = await auth.createSession(user.id)
    await db.root.execute(sql`DELETE FROM cms_users`)
    expect(await auth.userForSession(token)).toBeNull()
  })
})
