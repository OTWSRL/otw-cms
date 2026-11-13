import { createHash, randomBytes } from 'node:crypto'
import type { SignInContext, SignInMethod, SignInStep, User } from '@otwdesign/sdk'
import { and, eq, gt, sql } from 'drizzle-orm'
import { AuthError, type AuthService } from './auth'
import { signIns, users } from './core-schema'
import type { DatabaseContext } from './database'

/** How long a sign-in waits for its code. */
export const SIGN_IN_TTL_MS = 10 * 60 * 1000
/** Wrong codes an account may have typed, across its sign-ins, in the window below. */
export const MAX_CODE_FAILURES = 5
export const CODE_FAILURE_WINDOW_MS = 15 * 60 * 1000
/** The longest a browser can ask to be remembered: a year. */
export const MAX_REMEMBER_DAYS = 365

const TOKEN = /^[A-Za-z0-9_-]{43}$/
const MAX_CODE_LENGTH = 64
const RAN_OUT = 'That sign-in has run out. Sign in again.'
const THROTTLED = 'Too many wrong codes. Try again in 15 minutes.'

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

const newToken = () => randomBytes(32).toString('base64url')

/** A sign-in waiting for its code, as its screen shows it. */
export interface HeldSignIn {
  user: User
  via: SignInContext['via']
  /** The ways the person has, their default first. */
  methods: SignInMethod[]
  /** For how many days the screen offers to remember this browser; 0 doesn't offer it. */
  rememberDays: number
}

export type SignInStart =
  | { kind: 'session'; token: string }
  /** `problem` says why the default method's code couldn't be sent, for the screen to show. */
  | { kind: 'held'; token: string; problem: string | null }

export interface SignInServiceOptions {
  db: DatabaseContext
  auth: AuthService
  /** The step a plugin added, or `null`. */
  step(): SignInStep | null
  /** What a step threw to tell the person something: its message, or `null` for a real error. */
  message(error: unknown): string | null
  now?: () => Date
}

/**
 * What stands between proving who you are and a session: nothing, or the step a plugin added.
 * Then the sign-in is held, under a token only the browser has, until a code passes.
 */
export interface SignInService {
  /**
   * Signs `user` in, who has just proved who they are: a session at once, or a held sign-in
   * when the step has a way to ask them for a code.
   */
  begin(
    user: User,
    input: { via: SignInContext['via']; next: string; device: string | null },
  ): Promise<SignInStart>
  /** The sign-in a token holds, while it can still be finished. */
  held(token: string | null, device: string | null): Promise<HeldSignIn | null>
  /** Sends the method's code, again or for the first time. */
  send(token: string | null, method: string, device: string | null): Promise<void>
  /**
   * Finishes a held sign-in with a code: a session, where to go, and the id to remember this
   * browser by when the person asked. A wrong code is counted, and throws.
   */
  complete(
    token: string | null,
    input: { method: string; code: string; remember: boolean; device: string | null },
  ): Promise<{
    user: User
    session: string
    next: string
    device: { token: string; days: number } | null
  }>
}

export function createSignInService(options: SignInServiceOptions): SignInService {
  const { db, auth } = options
  const now = options.now ?? (() => new Date())
  const userColumns = { id: users.id, email: users.email, name: users.name, role: users.role }

  const knownDevice = (device: string | null) => (device && TOKEN.test(device) ? device : null)

  const rememberDays = (step: SignInStep, user: User): number => {
    const days = step.remember ? (step.rememberDays?.(user) ?? 0) : 0
    return Number.isSafeInteger(days) && days > 0 ? Math.min(days, MAX_REMEMBER_DAYS) : 0
  }

  /** Wrong codes the account has typed lately, over all its sign-ins. */
  const recentFailures = async (userId: string): Promise<number> => {
    const since = new Date(now().getTime() - CODE_FAILURE_WINDOW_MS)
    const [row] = await db.current
      .select({ failures: sql<number>`coalesce(sum(${signIns.failures}), 0)`.mapWith(Number) })
      .from(signIns)
      .where(and(eq(signIns.userId, userId), gt(signIns.createdAt, since)))
    return row?.failures ?? 0
  }

  /** The token's sign-in and its user, while it hasn't run out. */
  const find = async (token: string | null) => {
    if (!token || !TOKEN.test(token)) return null
    const [row] = await db.current
      .select({ user: userColumns, via: signIns.via, next: signIns.next })
      .from(signIns)
      .innerJoin(users, eq(users.id, signIns.userId))
      .where(and(eq(signIns.tokenHash, hashToken(token)), gt(signIns.expiresAt, now())))
      .limit(1)
    return row ?? null
  }

  /** Runs the step's `send`, turning what it says to the person into an `AuthError`. */
  const sendCode = async (step: SignInStep, user: User, method: string, context: SignInContext) => {
    try {
      await step.send?.(user, method, context)
    } catch (error) {
      const message = options.message(error)
      if (message === null) throw error
      throw new AuthError('invalid_input', message)
    }
  }

  return {
    async begin(user, { via, next, device }) {
      const step = options.step()
      const context: SignInContext = { via, device: knownDevice(device) }
      const methods = step ? await step.methods(user, context) : []
      if (!step || methods.length === 0) {
        return { kind: 'session', token: await auth.createSession(user.id) }
      }
      // Before a code is sent: an account past its wrong codes gets no more emails or texts.
      if ((await recentFailures(user.id)) >= MAX_CODE_FAILURES) {
        throw new AuthError('throttled', THROTTLED)
      }
      const token = newToken()
      const at = now()
      await db.current.insert(signIns).values({
        tokenHash: hashToken(token),
        userId: user.id,
        next,
        via,
        createdAt: at,
        expiresAt: new Date(at.getTime() + SIGN_IN_TTL_MS),
      })
      let problem: string | null = null
      if (methods[0]!.sends) {
        try {
          await sendCode(step, user, methods[0]!.id, context)
        } catch (error) {
          if (!(error instanceof AuthError)) throw error
          problem = error.message
        }
      }
      return { kind: 'held', token, problem }
    },

    async held(token, device) {
      const step = options.step()
      const row = step ? await find(token) : null
      if (!step || !row) return null
      const methods = await step.methods(row.user, { via: row.via, device: knownDevice(device) })
      if (methods.length === 0) return null
      return {
        user: row.user,
        via: row.via,
        methods,
        rememberDays: rememberDays(step, row.user),
      }
    },

    async send(token, method, device) {
      const step = options.step()
      const row = step ? await find(token) : null
      if (!step || !row) throw new AuthError('invalid_token', RAN_OUT)
      const context: SignInContext = { via: row.via, device: knownDevice(device) }
      const methods = await step.methods(row.user, context)
      if (!methods.some((candidate) => candidate.id === method && candidate.sends)) {
        throw new AuthError('invalid_input', 'Choose one of the ways shown.')
      }
      await sendCode(step, row.user, method, context)
    },

    async complete(token, input) {
      const step = options.step()
      const found = step ? await find(token) : null
      if (!step || !found || !token) throw new AuthError('invalid_token', RAN_OUT)
      const { user, via, next } = found
      const context: SignInContext = { via, device: knownDevice(input.device) }
      const code = input.code.replace(/\s+/g, '')

      const outcome = await db.transaction(async () => {
        // One code at a time for an account, whichever of its sign-ins it's typed against, so
        // guesses sent together are counted one by one.
        await db.current
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, user.id))
          .for('update')
        const [hold] = await db.current
          .select({ tokenHash: signIns.tokenHash })
          .from(signIns)
          .where(and(eq(signIns.tokenHash, hashToken(token)), gt(signIns.expiresAt, now())))
          .limit(1)
        if (!hold) return 'ran-out' as const
        if ((await recentFailures(user.id)) >= MAX_CODE_FAILURES) return 'throttled' as const
        const methods = await step.methods(user, context)
        const passed =
          code !== '' &&
          code.length <= MAX_CODE_LENGTH &&
          methods.some((candidate) => candidate.id === input.method) &&
          (await step.verify(user, input.method, code, context)) === true
        if (!passed) {
          await db.current
            .update(signIns)
            .set({ failures: sql`${signIns.failures} + 1` })
            .where(eq(signIns.tokenHash, hold.tokenHash))
          return 'wrong' as const
        }
        // Passed: this sign-in is used up, and the account's wrong codes are forgiven, as a
        // correct password forgives wrong ones.
        await db.current.delete(signIns).where(eq(signIns.userId, user.id))
        const days = input.remember ? rememberDays(step, user) : 0
        const device = days > 0 ? { token: newToken(), days } : null
        if (device) await step.remember!(user, device.token, days)
        return { session: await auth.createSession(user.id), device }
      })

      if (outcome === 'ran-out') throw new AuthError('invalid_token', RAN_OUT)
      if (outcome === 'throttled') throw new AuthError('throttled', THROTTLED)
      if (outcome === 'wrong') throw new AuthError('invalid_credentials', 'That code isn’t right.')
      return { user, next, ...outcome }
    },
  }
}
