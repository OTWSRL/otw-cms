import { createHash, randomBytes } from 'node:crypto'
import type { User } from '@otw/sdk'
import { and, asc, count, eq, gt, ilike, inArray, lt, or, sql, type SQL } from 'drizzle-orm'
import { ADMINISTRATOR } from './capabilities'
import { loginFailures, sessions, users } from './core-schema'
import type { DatabaseContext } from './database'
import { hashPassword, verifyPassword, type HashCost } from './passwords'

export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000
export const MAX_LOGIN_FAILURES = 5
export const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000
export const MIN_PASSWORD_LENGTH = 10
export const MAX_PASSWORD_LENGTH = 200

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const TOKEN = /^[A-Za-z0-9_-]{43}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Serialises first-run setup so two visitors can't both become the first administrator.
const SETUP_LOCK = 727_002

export type AuthErrorCode =
  | 'invalid_input'
  | 'invalid_credentials'
  | 'throttled'
  | 'email_taken'
  | 'unknown_role'
  | 'last_administrator'
  | 'not_found'
  | 'already_set_up'
  | 'invalid_token'
  | 'closed'

/** Messages are written for the person filling in the form. */
export class AuthError extends Error {
  readonly code: AuthErrorCode

  constructor(code: AuthErrorCode, message: string) {
    super(message)
    this.name = 'AuthError'
    this.code = code
  }
}

export interface NewUser {
  email: string
  name?: string
  role: string
  password: string
}

export interface AuthService {
  createUser(input: NewUser): Promise<User>
  /** First-run setup. Fails once any user exists. */
  createFirstAdministrator(input: Omit<NewUser, 'role'>): Promise<User>
  hasUsers(): Promise<boolean>
  /** Every user by email, or only those with one of `roles`, such as an Author dropdown's. */
  listUsers(options?: { roles?: readonly string[] }): Promise<User[]>
  /**
   * A page of users by email, as users.php lists them: one role's, and those whose email or
   * name has every word of `search`, with how many match.
   */
  findUsers(query?: UserQuery): Promise<{ users: User[]; total: number }>
  /** How many users each role has, in one query: the list's role views. */
  countUsersByRole(): Promise<Record<string, number>>
  /** These users, for showing who wrote a page of entries; ids that aren't users are left out. */
  getUsers(ids: readonly string[]): Promise<User[]>
  /** Refuses to demote the last administrator. */
  setRole(userId: string, role: string): Promise<User>
  /** All or none, like WordPress's "Change role to…"; refuses to leave no administrator. */
  setRoles(userIds: readonly string[], role: string): Promise<User[]>
  /** Throttled per email address; returns a new session token. */
  signIn(email: string, password: string): Promise<{ user: User; token: string }>
  /**
   * Whether `password` is the user's, as a form that changes their email or password asks:
   * counted against the same failed attempts as signing in. Throws `throttled` past them.
   */
  checkPassword(email: string, password: string): Promise<boolean>
  /** Ends every session of the user's but `except`, the one they're using. */
  signOutEverywhere(userId: string, except?: string | null): Promise<void>
  createSession(userId: string): Promise<string>
  userForSession(token: string | null | undefined): Promise<User | null>
  signOut(token: string | null | undefined): Promise<void>
}

export interface UserQuery {
  role?: string
  search?: string
  /** 1 to 100; defaults to 20, as WordPress's users screen shows. */
  limit?: number
  offset?: number
}

const MAX_USER_PAGE = 100
const MAX_SEARCH_WORDS = 10

function likeTerm(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
}

export interface AuthServiceOptions {
  roleExists(role: string): boolean
  hashCost?: HashCost
  now?: () => Date
}

const userColumns = { id: users.id, email: users.email, name: users.name, role: users.role }

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function createAuthService(db: DatabaseContext, options: AuthServiceOptions): AuthService {
  const now = options.now ?? (() => new Date())
  // Unknown emails still pay for a hash, so response time doesn't reveal which accounts exist.
  let decoy: Promise<string> | undefined
  const decoyHash = () =>
    (decoy ??= hashPassword(randomBytes(16).toString('hex'), options.hashCost))

  const validated = async (input: NewUser) => {
    const email = normalizeEmail(input.email)
    const name = (input.name ?? '').trim()
    if (!EMAIL.test(email) || email.length > 254) {
      throw new AuthError('invalid_input', 'Enter a valid email address.')
    }
    if (name.length > 100) {
      throw new AuthError('invalid_input', 'Names are limited to 100 characters.')
    }
    if (
      input.password.length < MIN_PASSWORD_LENGTH ||
      input.password.length > MAX_PASSWORD_LENGTH
    ) {
      throw new AuthError(
        'invalid_input',
        `Passwords need ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters.`,
      )
    }
    if (!options.roleExists(input.role)) {
      throw new AuthError('unknown_role', `There is no "${input.role}" role.`)
    }
    return {
      email,
      name,
      role: input.role,
      passwordHash: await hashPassword(input.password, options.hashCost),
    }
  }

  const insertUser = async (values: Awaited<ReturnType<typeof validated>>): Promise<User> => {
    const [row] = await db.current
      .insert(users)
      .values(values)
      .onConflictDoNothing({ target: users.email })
      .returning(userColumns)
    if (!row) throw new AuthError('email_taken', 'A user with that email address already exists.')
    return row
  }

  const createSession = async (userId: string): Promise<string> => {
    const token = randomBytes(32).toString('base64url')
    const at = now()
    await db.current
      .delete(sessions)
      .where(and(eq(sessions.userId, userId), lt(sessions.expiresAt, at)))
    await db.current.insert(sessions).values({
      tokenHash: hashToken(token),
      userId,
      expiresAt: new Date(at.getTime() + SESSION_TTL_MS),
    })
    return token
  }

  /**
   * The user whose password this is, or `null`: throttled per address, and as slow for an
   * address with no account, or no password yet, as for a real one.
   */
  const verified = async (rawEmail: string, password: string) => {
    const email = normalizeEmail(rawEmail)
    const windowStart = new Date(now().getTime() - LOGIN_FAILURE_WINDOW_MS)
    const [{ failures } = { failures: 0 }] = await db.current
      .select({ failures: count() })
      .from(loginFailures)
      .where(and(eq(loginFailures.email, email), gt(loginFailures.failedAt, windowStart)))
    if (failures >= MAX_LOGIN_FAILURES) {
      throw new AuthError('throttled', 'Too many failed attempts. Try again in 15 minutes.')
    }
    const [row] = await db.current.select().from(users).where(eq(users.email, email)).limit(1)
    const valid =
      password.length <= MAX_PASSWORD_LENGTH &&
      (await verifyPassword(password, row?.passwordHash || (await decoyHash())))
    if (!row || !valid) {
      await db.current.insert(loginFailures).values({ email, failedAt: now() })
      await db.current.delete(loginFailures).where(lt(loginFailures.failedAt, windowStart))
      return null
    }
    await db.current.delete(loginFailures).where(eq(loginFailures.email, email))
    return row
  }

  /** How many match, for a page past the last: its window count has no row to ride on. */
  const countWhere = async (where: SQL | undefined) => {
    const [row] = await db.current.select({ total: count() }).from(users).where(where)
    return row?.total ?? 0
  }

  const service: AuthService = {
    async createUser(input) {
      return insertUser(await validated(input))
    },

    async createFirstAdministrator(input) {
      const values = await validated({ ...input, role: ADMINISTRATOR })
      return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${SETUP_LOCK})`)
        const [existing] = await tx.select({ id: users.id }).from(users).limit(1)
        if (existing) {
          throw new AuthError('already_set_up', 'This site already has an administrator.')
        }
        return insertUser(values)
      })
    },

    async hasUsers() {
      const [row] = await db.current.select({ id: users.id }).from(users).limit(1)
      return row !== undefined
    },

    async listUsers({ roles } = {}) {
      if (roles?.length === 0) return []
      return db.current
        .select(userColumns)
        .from(users)
        .where(roles ? inArray(users.role, [...roles]) : undefined)
        .orderBy(asc(users.email))
    },

    async findUsers({ role, search = '', limit = 20, offset = 0 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_USER_PAGE) {
        throw new AuthError('invalid_input', `Show 1 to ${MAX_USER_PAGE} users at a time.`)
      }
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new AuthError('invalid_input', 'The offset must be 0 or more.')
      }
      const words = search.trim().split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_WORDS)
      const where = and(
        role === undefined ? undefined : eq(users.role, role),
        ...words.map((word) =>
          or(ilike(users.email, likeTerm(word)), ilike(users.name, likeTerm(word))),
        ),
      )
      const rows = await db.current
        .select({ ...userColumns, total: sql<number>`count(*) over ()`.mapWith(Number) })
        .from(users)
        .where(where)
        .orderBy(asc(users.email))
        .limit(limit)
        .offset(offset)
      return {
        users: rows.map(({ total: _total, ...user }) => user),
        total: rows[0]?.total ?? (offset > 0 ? await countWhere(where) : 0),
      }
    },

    async countUsersByRole() {
      const rows = await db.current
        .select({ role: users.role, total: count() })
        .from(users)
        .groupBy(users.role)
      return Object.fromEntries(rows.map((row) => [row.role, row.total]))
    },

    async getUsers(ids) {
      const valid = [...new Set(ids)].filter((id) => UUID.test(id))
      if (valid.length === 0) return []
      return db.current.select(userColumns).from(users).where(inArray(users.id, valid))
    },

    async setRole(userId, role) {
      const [updated] = await service.setRoles([userId], role)
      return updated!
    },

    setRoles(userIds, role) {
      const ids = [...new Set(userIds)]
      if (!options.roleExists(role)) {
        return Promise.reject(new AuthError('unknown_role', `There is no "${role}" role.`))
      }
      if (ids.length === 0 || !ids.every((id) => UUID.test(id))) {
        return Promise.reject(new AuthError('not_found', 'That user no longer exists.'))
      }
      return db.transaction(async (tx) => {
        // Locking every administrator serialises concurrent demotions of different admins.
        const admins = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.role, ADMINISTRATOR))
          .for('update')
        const targets = await tx
          .select(userColumns)
          .from(users)
          .where(inArray(users.id, ids))
          .for('update')
        if (targets.length !== ids.length) {
          throw new AuthError('not_found', 'That user no longer exists.')
        }
        const demoted =
          role === ADMINISTRATOR ? 0 : targets.filter((user) => user.role === ADMINISTRATOR).length
        if (demoted > 0 && admins.length - demoted < 1) {
          throw new AuthError('last_administrator', 'The site needs at least one administrator.')
        }
        return tx.update(users).set({ role }).where(inArray(users.id, ids)).returning(userColumns)
      })
    },

    async signIn(rawEmail, password) {
      const row = await verified(rawEmail, password)
      if (!row) throw new AuthError('invalid_credentials', 'Incorrect email or password.')
      const { id, email, name, role } = row
      return { user: { id, email, name, role }, token: await createSession(id) }
    },

    async checkPassword(email, password) {
      return (await verified(email, password)) !== null
    },

    async signOutEverywhere(userId, except) {
      if (!UUID.test(userId)) return
      const keep = except && TOKEN.test(except) ? hashToken(except) : null
      await db.current
        .delete(sessions)
        .where(
          and(
            eq(sessions.userId, userId),
            keep ? sql`${sessions.tokenHash} <> ${keep}` : undefined,
          ),
        )
    },

    createSession,

    async userForSession(token) {
      if (!token || !TOKEN.test(token)) return null
      const [row] = await db.current
        .select(userColumns)
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, now())))
        .limit(1)
      return row ?? null
    },

    async signOut(token) {
      if (!token || !TOKEN.test(token)) return
      await db.current.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)))
    },
  }
  return service
}
