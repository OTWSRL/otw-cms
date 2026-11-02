import { createHash, randomBytes } from 'node:crypto'
import type { Logger, User } from '@otw/sdk'
import { and, count, eq, gt, sql } from 'drizzle-orm'
import {
  AuthError,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  normalizeEmail,
  type AuthService,
} from './auth'
import { userTokens, users, type UserTokenPurpose } from './core-schema'
import { isUniqueViolation } from './content'
import type { DatabaseContext } from './database'
import type { MailService } from './mail'
import { hashPassword, type HashCost } from './passwords'

/** Where the site's account pages live: WooCommerce's My Account. */
export const ACCOUNT_PATH = '/account'
/** How long an emailed link works: WordPress's `password_reset_expiration`, a day. */
export const TOKEN_TTL_MS = 24 * 60 * 60 * 1000
/** Emails one address gets from sign-up, reset and email changes in an hour, at most. */
export const MAX_EMAILS_PER_HOUR = 3
/** The role sign-ups get, as WooCommerce gives its customers. */
export const SIGN_UP_ROLE = 'customer'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const TOKEN = /^[A-Za-z0-9_-]{43}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HOUR_MS = 60 * 60 * 1000

const userColumns = { id: users.id, email: users.email, name: users.name, role: users.role }

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function cleanEmail(value: unknown): string {
  const email = typeof value === 'string' ? normalizeEmail(value) : ''
  if (!EMAIL.test(email) || email.length > 254) {
    throw new AuthError('invalid_input', 'Enter a valid email address.')
  }
  return email
}

function cleanName(value: unknown): string {
  const name = typeof value === 'string' ? value.replace(/\p{Cc}+/gu, ' ').trim() : ''
  if (name.length > 100)
    throw new AuthError('invalid_input', 'Names are limited to 100 characters.')
  return name
}

function checkNewPassword(password: unknown): string {
  if (
    typeof password !== 'string' ||
    password.length < MIN_PASSWORD_LENGTH ||
    password.length > MAX_PASSWORD_LENGTH
  ) {
    throw new AuthError(
      'invalid_input',
      `Passwords need ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters.`,
    )
  }
  return password
}

const EXPIRED = 'This link has expired or has already been used. Ask for a new one.'

export interface AccountServiceOptions {
  db: DatabaseContext
  auth: AuthService
  mail: MailService
  logger: Logger
  /** Settings › General: the site's name, for subjects, and whether anyone can register. */
  siteTitle(): string
  registrationOpen(): boolean
  roleExists(role: string): boolean
  hashCost?: HashCost
  now?: () => Date
}

/**
 * People's own accounts on the site, as `wp-login.php` and WooCommerce's My Account handle
 * them: signing up with an address they prove by using the link sent to it, resetting a lost
 * password, and changing their name, password and address. No form says whether an account
 * exists: the email does, to its owner.
 */
export interface AccountService {
  /** Settings › General's "Anyone can register", and a mail plugin to send the link with. */
  canRegister(): boolean
  /**
   * Signs someone up, as WordPress does: an account with no password yet, and an email with a
   * link to set one. An address that has an account gets an email saying so, with a link to set
   * a new password, and the caller can't tell which.
   */
  register(input: { email: string; name?: string }, origin: string): Promise<void>
  /** Emails a link to set a new password, if an account uses the address: `retrieve_password()`. */
  requestPasswordReset(email: string, origin: string): Promise<void>
  /** The account a link is for, and for `email` the address it confirms, while it works. */
  tokenInfo(
    token: string,
    purpose: UserTokenPurpose,
  ): Promise<{ user: User; newEmail: string | null } | null>
  /**
   * Sets the password from an emailed link, which proves the address: the account is verified,
   * the link and its siblings stop working, and every session ends, as a reset does in WordPress.
   */
  setPassword(token: string, password: string): Promise<User>
  /** Asks for the current password; ends every other session, and tells the address. */
  changePassword(user: User, current: string, next: string, session: string | null): Promise<void>
  changeName(user: User, name: string): Promise<User>
  /**
   * An administrator's change of someone's address, at once, as user-edit.php makes it: the old
   * address is told, and the new one isn't proved until a link sent to it is used.
   */
  setEmail(user: User, email: string): Promise<User>
  /**
   * Asks for the password, then emails the new address a link to confirm it; nothing changes
   * until it's used.
   */
  requestEmailChange(user: User, password: string, newEmail: string, origin: string): Promise<void>
  /** Changes the address from its link, and tells the old one, as WordPress does. */
  confirmEmail(token: string): Promise<User>
  /** Whether the user has proved they read their address. */
  isVerified(userId: string): Promise<boolean>
}

export function createAccountService(options: AccountServiceOptions): AccountService {
  const { db, auth, mail, logger } = options
  const now = options.now ?? (() => new Date())
  const subject = (text: string) => `[${options.siteTitle() || 'My Site'}] ${text}`
  const link = (origin: string, path: string, token: string) =>
    `${origin}${ACCOUNT_PATH}${path}?token=${token}`

  /**
   * A new link for the user, or `null` when their address has had its hour's emails, so a form
   * can't be used to flood someone's inbox.
   */
  const issue = async (
    userId: string,
    purpose: UserTokenPurpose,
    newEmail: string | null = null,
  ): Promise<string | null> => {
    const since = new Date(now().getTime() - HOUR_MS)
    const [{ recent } = { recent: 0 }] = await db.current
      .select({ recent: count() })
      .from(userTokens)
      .where(and(eq(userTokens.userId, userId), gt(userTokens.createdAt, since)))
    if (recent >= MAX_EMAILS_PER_HOUR) {
      logger.info('An account email was not sent: its hourly limit was reached', { userId })
      return null
    }
    const token = randomBytes(32).toString('base64url')
    await db.current.insert(userTokens).values({
      userId,
      purpose,
      tokenHash: hashToken(token),
      newEmail,
      createdAt: now(),
      expiresAt: new Date(now().getTime() + TOKEN_TTL_MS),
    })
    return token
  }

  /** The token's row while it works, locked for a change that uses it. */
  const usable = async (token: string, purpose: UserTokenPurpose) => {
    if (typeof token !== 'string' || !TOKEN.test(token)) return null
    const [row] = await db.current
      .select()
      .from(userTokens)
      .where(
        and(
          eq(userTokens.tokenHash, hashToken(token)),
          eq(userTokens.purpose, purpose),
          gt(userTokens.expiresAt, now()),
        ),
      )
      .for('update')
      .limit(1)
    return row ?? null
  }

  const userById = async (id: string): Promise<User | null> => {
    const [row] = await db.current.select(userColumns).from(users).where(eq(users.id, id)).limit(1)
    return row ?? null
  }

  const send = (to: string, title: string, lines: string[]) =>
    mail.send({ to, subject: subject(title), text: lines.join('\n') })

  const service: AccountService = {
    canRegister: () => options.registrationOpen() && mail.canSend(),

    async register(input, origin) {
      if (!options.registrationOpen()) {
        throw new AuthError('closed', 'This site isn’t taking sign-ups.')
      }
      const email = cleanEmail(input.email)
      const name = cleanName(input.name ?? '')
      if (!options.roleExists(SIGN_UP_ROLE)) {
        throw new AuthError('closed', 'This site isn’t taking sign-ups.')
      }
      const site = options.siteTitle() || 'this site'
      const [existing] = await db.current
        .select(userColumns)
        .from(users)
        .where(eq(users.email, email))
        .limit(1)
      if (existing) {
        const token = await issue(existing.id, 'password')
        if (token) {
          await send(email, 'You already have an account', [
            `Someone, hopefully you, tried to sign up at ${site} with this email address, which already has an account.`,
            '',
            `To sign in, visit: ${origin}${ACCOUNT_PATH}`,
            `To set a new password, visit: ${link(origin, '/reset', token)}`,
            '',
            'If it wasn’t you, ignore this email: nothing has changed.',
          ])
        }
        return
      }
      const created = await db.transaction(async () => {
        const [row] = await db.current
          .insert(users)
          .values({ email, name, role: SIGN_UP_ROLE, passwordHash: '' })
          .onConflictDoNothing({ target: users.email })
          .returning(userColumns)
        return row ? { user: row, token: await issue(row.id, 'password') } : null
      })
      // Two sign-ups at once: the other made the account, and its email is on its way.
      if (!created?.token) return
      await send(email, 'Set your password', [
        `Welcome to ${site}.`,
        '',
        `To set your password and sign in, visit: ${link(origin, '/reset', created.token)}`,
        '',
        'The link works for 24 hours. If you didn’t sign up, ignore this email.',
      ])
    },

    async requestPasswordReset(rawEmail, origin) {
      const email = cleanEmail(rawEmail)
      const [user] = await db.current
        .select(userColumns)
        .from(users)
        .where(eq(users.email, email))
        .limit(1)
      if (!user) return
      const token = await issue(user.id, 'password')
      if (!token) return
      await send(email, 'Password reset', [
        `Someone has asked to reset the password of your account at ${options.siteTitle() || 'this site'}.`,
        '',
        `To set a new password, visit: ${link(origin, '/reset', token)}`,
        '',
        'The link works for 24 hours. If this was a mistake, ignore this email and nothing will change.',
      ])
    },

    async tokenInfo(token, purpose) {
      const row = await db.transaction(() => usable(token, purpose))
      const user = row ? await userById(row.userId) : null
      return row && user ? { user, newEmail: row.newEmail } : null
    },

    async setPassword(token, password) {
      const hash = await hashPassword(checkNewPassword(password), options.hashCost)
      return db.transaction(async () => {
        const row = await usable(token, 'password')
        if (!row) throw new AuthError('invalid_token', EXPIRED)
        const [user] = await db.current
          .update(users)
          .set({
            passwordHash: hash,
            emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())`,
          })
          .where(eq(users.id, row.userId))
          .returning(userColumns)
        await db.current
          .delete(userTokens)
          .where(and(eq(userTokens.userId, row.userId), eq(userTokens.purpose, 'password')))
        await auth.signOutEverywhere(row.userId)
        return user!
      })
    },

    async changePassword(user, current, next, session) {
      const password = checkNewPassword(next)
      if (!(await auth.checkPassword(user.email, current))) {
        throw new AuthError('invalid_credentials', 'Your current password is incorrect.')
      }
      const hash = await hashPassword(password, options.hashCost)
      await db.transaction(async () => {
        await db.current.update(users).set({ passwordHash: hash }).where(eq(users.id, user.id))
        await auth.signOutEverywhere(user.id, session)
      })
      // WordPress's "Password Changed" email: the owner hears of it, wherever they are.
      await send(user.email, 'Your password was changed', [
        `The password of your account at ${options.siteTitle() || 'this site'} was just changed.`,
        '',
        'If you didn’t change it, reset it now from the sign-in page, and every session will end.',
      ])
    },

    async changeName(user, name) {
      const [updated] = await db.current
        .update(users)
        .set({ name: cleanName(name) })
        .where(eq(users.id, user.id))
        .returning(userColumns)
      if (!updated) throw new AuthError('not_found', 'That user no longer exists.')
      return updated
    },

    async setEmail(user, rawEmail) {
      const email = cleanEmail(rawEmail)
      if (email === user.email) return user
      let updated: User | undefined
      try {
        ;[updated] = await db.current
          .update(users)
          .set({ email, emailVerifiedAt: null })
          .where(eq(users.id, user.id))
          .returning(userColumns)
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new AuthError('email_taken', 'A user with that email address already exists.')
        }
        throw error
      }
      if (!updated) throw new AuthError('not_found', 'That user no longer exists.')
      await send(user.email, 'Your email address was changed', [
        `The email address of your account at ${options.siteTitle() || 'this site'} is now ${email}.`,
        '',
        'If you didn’t ask for this, contact the site’s administrator.',
      ])
      return updated
    },

    async requestEmailChange(user, password, rawEmail, origin) {
      const email = cleanEmail(rawEmail)
      if (email === user.email) {
        throw new AuthError('invalid_input', 'That’s already your email address.')
      }
      if (!(await auth.checkPassword(user.email, password))) {
        throw new AuthError('invalid_credentials', 'Your current password is incorrect.')
      }
      const [taken] = await db.current
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1)
      if (taken)
        throw new AuthError('email_taken', 'A user with that email address already exists.')
      const token = await issue(user.id, 'email', email)
      if (!token) {
        throw new AuthError('throttled', 'Too many emails were sent. Try again in an hour.')
      }
      const sent = await send(email, 'Confirm your new email address', [
        `To use this address for your account at ${options.siteTitle() || 'this site'}, visit: ${link(origin, '/email', token)}`,
        '',
        'The link works for 24 hours. Until then, your account keeps its current address.',
      ])
      if (!sent) {
        throw new AuthError(
          'invalid_input',
          'The confirmation email couldn’t be sent. Try again later.',
        )
      }
    },

    async confirmEmail(token) {
      const { user, previous } = await db.transaction(async () => {
        const row = await usable(token, 'email')
        if (!row?.newEmail) throw new AuthError('invalid_token', EXPIRED)
        const before = await userById(row.userId)
        if (!before) throw new AuthError('invalid_token', EXPIRED)
        let after: User | undefined
        try {
          ;[after] = await db.current
            .update(users)
            .set({ email: row.newEmail, emailVerifiedAt: now() })
            .where(eq(users.id, row.userId))
            .returning(userColumns)
        } catch (error) {
          // Another account took the address since the link was sent.
          if (isUniqueViolation(error)) {
            throw new AuthError('email_taken', 'Another account uses that address now.')
          }
          throw error
        }
        await db.current
          .delete(userTokens)
          .where(and(eq(userTokens.userId, row.userId), eq(userTokens.purpose, 'email')))
        return { user: after!, previous: before }
      })
      await send(previous.email, 'Your email address was changed', [
        `The email address of your account at ${options.siteTitle() || 'this site'} is now ${user.email}.`,
        '',
        'If you didn’t change it, contact the site’s administrator.',
      ])
      return user
    },

    async isVerified(userId) {
      if (!UUID.test(userId)) return false
      const [row] = await db.current
        .select({ at: users.emailVerifiedAt })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
      return Boolean(row?.at)
    },
  }
  return service
}
