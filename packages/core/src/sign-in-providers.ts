import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  ActionError,
  type ApiRoute,
  type Logger,
  type SignInIdentity,
  type SignInProvider,
  type SignInProviderLink,
  type User,
} from '@otwdesign/sdk'
import { and, eq, sql } from 'drizzle-orm'
import { ACCOUNT_PATH } from './accounts'
import { ADMIN_PREFIX, LOGIN_PATH, safeRedirectPath } from './admin'
import { apiPath } from './api'
import { AuthError, normalizeEmail } from './auth'
import { identities, users } from './core-schema'
import type { DatabaseContext } from './database'
import { withFlash, type FlashCodec } from './flash'
import { publicOrigin, type OriginPolicy } from './origins'
import { cookieValue, DEVICE_COOKIE_NAMES, parseCookies } from './session-cookie'
import type { SignInService } from './sign-in'
import { startedSignIn } from './sign-in-actions'

/** How long someone has to come back from the provider. */
export const PROVIDER_SIGN_IN_TTL_MS = 10 * 60 * 1000
/** The sign-in under way at a provider: what was asked, kept in the browser, signed. */
export const PROVIDER_COOKIE_NAMES = ['__Host-cms_sign_in_with', 'cms_sign_in_with'] as const

const CORE = 'core'
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,30}$/
const IMAGE = /^data:image\/(?:svg\+xml|png);base64,[A-Za-z0-9+/]+={0,2}$/
const MAX_IMAGE_LENGTH = 8 * 1024
const MAX_TEXT_LENGTH = 60
const RANDOM = /^[A-Za-z0-9_-]{43}$/
/** Printable ASCII with no spaces: what providers use for ids. */
const SUBJECT = /^[\x21-\x7e]{1,255}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_NEXT_LENGTH = 2000
const MAX_COOKIE_LENGTH = 4000
const RAN_OUT = 'That sign-in has run out. Try again.'

type Screen = 'admin' | 'account'

/** A sign-in on its way to a provider and back. */
interface Pending {
  provider: string
  state: string
  verifier: string
  next: string
  screen: Screen
  expires: number
}

interface PendingCodec {
  seal(pending: Pending): string
  /** `null` for anything this site didn't sign, or that has run out. */
  open(value: string | null): Pending | null
}

/**
 * The cookie that carries a provider sign-in while the person is away. Signed, so the place
 * they come back to and the state they must bring can't be chosen by someone else.
 */
export function createPendingCodec(secret: string, now: () => number = Date.now): PendingCodec {
  // Its own label, so a value signed for another purpose with the same secret never passes here.
  const sign = (payload: string) =>
    createHmac('sha256', secret).update(`sign-in-provider:${payload}`).digest()
  return {
    seal(pending) {
      const payload = Buffer.from(
        JSON.stringify({
          p: pending.provider,
          s: pending.state,
          v: pending.verifier,
          n: pending.next,
          a: pending.screen,
          e: pending.expires,
        }),
      ).toString('base64url')
      return `${payload}.${sign(payload).toString('base64url')}`
    },
    open(value) {
      if (!value || value.length > MAX_COOKIE_LENGTH) return null
      const [payload, signature, ...rest] = value.split('.')
      if (!payload || !signature || rest.length > 0) return null
      // Compared as written: decoding first would let one signature pass in two spellings.
      if (!sameText(signature, sign(payload).toString('base64url'))) return null
      let data: unknown
      try {
        data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
      } catch {
        return null
      }
      const { p, s, v, n, a, e } = (data ?? {}) as Record<string, unknown>
      if (
        typeof p !== 'string' ||
        typeof s !== 'string' ||
        typeof v !== 'string' ||
        typeof n !== 'string' ||
        (a !== 'admin' && a !== 'account') ||
        typeof e !== 'number' ||
        e <= now()
      ) {
        return null
      }
      return { provider: p, state: s, verifier: v, next: n, screen: a, expires: e }
    },
  }
}

function pendingCookie(value: string, secure: boolean, maxAgeSeconds: number): string {
  // Lax, not Strict: the person comes back by a link from the provider's site.
  const attributes = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`
  return secure
    ? `${PROVIDER_COOKIE_NAMES[0]}=${value}; ${attributes}; Secure`
    : `${PROVIDER_COOKIE_NAMES[1]}=${value}; ${attributes}`
}

const clearedPendingCookies = (): string[] => [
  pendingCookie('', true, 0),
  pendingCookie('', false, 0),
]

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** A provider's address to send someone to: https, or plain http on this machine for tests. */
function providerAddress(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4000) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null
  return url.href
}

interface CleanIdentity {
  subject: string
  email: string
  emailVerified: boolean
  emailOwned: boolean
  name: string
}

/** What a provider returned, checked: a plugin's answer is input like any other. */
function cleanIdentity(identity: SignInIdentity): CleanIdentity {
  const given: Partial<Record<keyof SignInIdentity, unknown>> = identity ?? {}
  const { subject, email, name } = given
  if (typeof subject !== 'string' || !SUBJECT.test(subject)) {
    throw new TypeError('A sign-in provider returned no usable subject')
  }
  const address = typeof email === 'string' ? normalizeEmail(email) : ''
  if (!EMAIL.test(address) || address.length > 254) {
    throw new TypeError('A sign-in provider returned no usable email address')
  }
  const emailVerified = given.emailVerified === true
  return {
    subject,
    email: address,
    emailVerified,
    // An address nobody verified can't be one the provider is the authority for.
    emailOwned: emailVerified && given.emailOwned === true,
    name:
      typeof name === 'string'
        ? name
            .replace(/\p{Cc}/gu, '')
            .trim()
            .slice(0, 100)
        : '',
  }
}

interface Registered {
  pluginId: string
  provider: SignInProvider
}

export interface SignInProviderOptions {
  db: DatabaseContext
  signIns: Pick<SignInService, 'begin'>
  flash: FlashCodec
  secret: string
  origins: OriginPolicy
  logger: Logger
  roleExists(role: string): boolean
  canUseAdmin(user: User): boolean
  now?: () => number
}

export interface SignInProviders {
  /** Adds a plugin's provider; throws for one that can't be shown or addressed. */
  add(pluginId: string, provider: SignInProvider): void
  /** The sign-in pages' buttons, in the order plugins added them. */
  links(screen: Screen, next: string | null): SignInProviderLink[]
  /** Core's two addresses per provider: where a sign-in starts, and where it comes back. */
  routes(): ApiRoute[]
  link(pluginId: string, provider: string, user: User, subject: string): Promise<void>
  unlink(pluginId: string, provider: string, user: User, subject?: string): Promise<void>
}

/**
 * Signing in at another service. Core keeps the parts that decide who gets in: the state that
 * ties the way back to the browser that left, which account an identity is, and the session. A
 * plugin's provider only builds the address to leave by and reads who came back.
 */
export function createSignInProviders(options: SignInProviderOptions): SignInProviders {
  const { db, flash, logger, origins } = options
  const now = options.now ?? Date.now
  const codec = createPendingCodec(options.secret, now)
  const providers = new Map<string, Registered>()
  const userColumns = { id: users.id, email: users.email, name: users.name, role: users.role }

  const site = (request: Request) => {
    const address = origins.siteUrl() ?? publicOrigin(request, origins.trustProxy)
    const url = new URL(address)
    return { origin: url.origin, secure: url.protocol === 'https:' }
  }
  const callbackPath = (id: string) => apiPath(CORE, `/sign-in/${id}/callback`)

  const redirect = (location: string, cookies: readonly string[] = []): Response => {
    const headers = new Headers({
      Location: location,
      'Cache-Control': 'no-store',
      // The way back carries the provider's code in its address.
      'Referrer-Policy': 'no-referrer',
    })
    for (const cookie of cookies) headers.append('Set-Cookie', cookie)
    return new Response(null, { status: 303, headers })
  }

  const failed = (screen: Screen, message: string): Response =>
    redirect(
      withFlash(
        screen === 'account' ? ACCOUNT_PATH : LOGIN_PATH,
        flash.encode({ kind: 'error', message }),
      ),
      clearedPendingCookies(),
    )

  const owned = (pluginId: string, id: string): Registered => {
    const registered = providers.get(id)
    if (!registered || registered.pluginId !== pluginId) {
      throw new Error(`Plugin "${pluginId}" has no sign-in provider "${id}"`)
    }
    return registered
  }

  /**
   * The account an identity signs in to: the one its id is linked to, else the one with its
   * address when the provider is the authority for that address, else a new one when the
   * provider gives new people a role.
   */
  const accountFor = async ({ pluginId, provider }: Registered, identity: CleanIdentity) =>
    db.transaction(async () => {
      const [linked] = await db.current
        .select(userColumns)
        .from(identities)
        .innerJoin(users, eq(users.id, identities.userId))
        .where(and(eq(identities.provider, provider.id), eq(identities.subject, identity.subject)))
        .limit(1)
      if (linked) return linked

      if (!identity.emailVerified) {
        throw new AuthError(
          'invalid_credentials',
          `${provider.name} hasn’t confirmed that email address, so it can’t be used to sign in here.`,
        )
      }
      const link = (userId: string) =>
        db.current
          .insert(identities)
          .values({
            provider: provider.id,
            subject: identity.subject,
            userId,
            plugin: pluginId,
          })
          .onConflictDoNothing()

      const [existing] = await db.current
        .select(userColumns)
        .from(users)
        .where(eq(users.email, identity.email))
        .limit(1)
      if (existing) {
        if (!identity.emailOwned) {
          throw new AuthError(
            'invalid_credentials',
            `An account here already uses ${identity.email}. Sign in with its password.`,
          )
        }
        await link(existing.id)
        // The provider hosts the mailbox: the address is proved, as by a link sent to it.
        await db.current
          .update(users)
          .set({ emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())` })
          .where(eq(users.id, existing.id))
        return existing
      }

      const role = provider.newAccountRole?.(identity) ?? null
      if (typeof role !== 'string' || !options.roleExists(role)) {
        throw new AuthError('closed', `There’s no account for ${identity.email} on this site.`)
      }
      const [created] = await db.current
        .insert(users)
        .values({
          email: identity.email,
          name: identity.name,
          role,
          // No password until they set one, from "Lost your password?".
          passwordHash: '',
          emailVerifiedAt: new Date(now()),
        })
        .onConflictDoNothing({ target: users.email })
        .returning(userColumns)
      // Someone made the account in this same moment: the next try finds it.
      if (!created) throw new AuthError('invalid_token', RAN_OUT)
      await link(created.id)
      return created
    })

  const start: ApiRoute['handler'] = async (request, { params }) => {
    const registered = providers.get(params.provider ?? '')
    if (!registered) return Response.json({ error: 'Not found' }, { status: 404 })
    const { provider } = registered
    const url = new URL(request.url)
    const screen: Screen = url.searchParams.get('screen') === 'account' ? 'account' : 'admin'
    const asked = url.searchParams.get('next')
    const next =
      (asked && asked.length <= MAX_NEXT_LENGTH ? safeRedirectPath(asked) : null) ??
      (screen === 'account' ? ACCOUNT_PATH : ADMIN_PREFIX)
    const { origin, secure } = site(request)
    const pending: Pending = {
      provider: provider.id,
      state: randomBytes(32).toString('base64url'),
      verifier: randomBytes(32).toString('base64url'),
      next,
      screen,
      expires: now() + PROVIDER_SIGN_IN_TTL_MS,
    }
    let address: string | null
    try {
      address = providerAddress(
        await provider.start({
          redirectUri: origin + callbackPath(provider.id),
          state: pending.state,
          verifier: pending.verifier,
        }),
      )
    } catch (error) {
      if (error instanceof ActionError) return failed(screen, error.message)
      logger.error('A sign-in provider could not start', { provider: provider.id, error })
      address = null
    }
    if (!address)
      return failed(screen, `Signing in with ${provider.name} isn’t working. Try again.`)
    return redirect(address, [
      pendingCookie(codec.seal(pending), secure, PROVIDER_SIGN_IN_TTL_MS / 1000),
    ])
  }

  const callback: ApiRoute['handler'] = async (request, { params }) => {
    const registered = providers.get(params.provider ?? '')
    if (!registered) return Response.json({ error: 'Not found' }, { status: 404 })
    const { provider } = registered
    const url = new URL(request.url)
    const { origin, secure } = site(request)
    const cookies = parseCookies(request.headers.get('cookie'))
    // On https only the `__Host-` cookie counts: a plain one can be planted from a subdomain.
    const pending = codec.open(
      cookieValue(cookies, secure ? [PROVIDER_COOKIE_NAMES[0]] : PROVIDER_COOKIE_NAMES),
    )
    if (!pending || pending.provider !== provider.id) return failed('admin', RAN_OUT)
    const { screen } = pending
    const state = url.searchParams.get('state') ?? ''
    if (!RANDOM.test(state) || !sameText(state, pending.state)) return failed(screen, RAN_OUT)

    let identity: CleanIdentity
    try {
      identity = cleanIdentity(
        await provider.finish({
          redirectUri: origin + callbackPath(provider.id),
          state: pending.state,
          verifier: pending.verifier,
          params: url.searchParams,
        }),
      )
    } catch (error) {
      if (error instanceof ActionError) return failed(screen, error.message)
      logger.error('A sign-in provider could not finish', { provider: provider.id, error })
      return failed(screen, `Signing in with ${provider.name} didn’t work. Try again.`)
    }

    try {
      const user = await accountFor(registered, identity)
      const admin = pending.next === ADMIN_PREFIX || pending.next.startsWith(`${ADMIN_PREFIX}/`)
      const next = admin && !options.canUseAdmin(user) ? ACCOUNT_PATH : pending.next
      const begun = await options.signIns.begin(user, {
        via: 'provider',
        next,
        device: cookieValue(cookies, DEVICE_COOKIE_NAMES),
      })
      const done = startedSignIn(begun, { secure, next, screen })
      return redirect(
        done.notice
          ? withFlash(done.redirect!, flash.encode({ kind: 'notice', message: done.notice }))
          : done.redirect!,
        [...(done.cookies ?? []), ...clearedPendingCookies()],
      )
    } catch (error) {
      if (error instanceof AuthError) return failed(screen, error.message)
      throw error
    }
  }

  return {
    add(pluginId, provider) {
      if (!provider || typeof provider.id !== 'string' || !PROVIDER_ID.test(provider.id)) {
        throw new TypeError(
          `A sign-in provider from "${pluginId}" needs an id of lowercase letters, digits and hyphens`,
        )
      }
      const existing = providers.get(provider.id)
      if (existing) {
        throw new Error(
          `Plugin "${pluginId}" adds the sign-in provider "${provider.id}", but "${existing.pluginId}" already does`,
        )
      }
      for (const key of ['label', 'name'] as const) {
        const value = provider[key]
        if (typeof value !== 'string' || !value.trim() || value.length > MAX_TEXT_LENGTH) {
          throw new TypeError(
            `The sign-in provider "${provider.id}" needs a ${key} of up to ${MAX_TEXT_LENGTH} characters`,
          )
        }
      }
      if (typeof provider.start !== 'function' || typeof provider.finish !== 'function') {
        throw new TypeError(`The sign-in provider "${provider.id}" needs start() and finish()`)
      }
      if (
        provider.image !== undefined &&
        (typeof provider.image !== 'string' ||
          provider.image.length > MAX_IMAGE_LENGTH ||
          !IMAGE.test(provider.image))
      ) {
        throw new TypeError(
          `The sign-in provider "${provider.id}" needs its image as a base64 data: address of an SVG or PNG, up to ${MAX_IMAGE_LENGTH} characters`,
        )
      }
      providers.set(provider.id, { pluginId, provider })
    },

    links(screen, next) {
      if (providers.size === 0) return []
      const query = new URLSearchParams({ screen })
      const path = next && next.length <= MAX_NEXT_LENGTH ? safeRedirectPath(next) : null
      if (path) query.set('next', path)
      return [...providers.values()].map(({ provider }) => ({
        id: provider.id,
        label: provider.label,
        image: provider.image ?? null,
        url: `${apiPath(CORE, `/sign-in/${provider.id}`)}?${query}`,
      }))
    },

    routes() {
      return [
        { method: 'GET', path: '/sign-in/:provider', handler: start },
        { method: 'GET', path: '/sign-in/:provider/callback', handler: callback },
      ]
    },

    async link(pluginId, id, user, subject) {
      const { provider } = owned(pluginId, id)
      if (typeof subject !== 'string' || !SUBJECT.test(subject)) {
        throw new TypeError('linkIdentity() needs the provider’s id for the person')
      }
      await db.current
        .insert(identities)
        .values({ provider: id, subject, userId: user.id, plugin: pluginId })
        .onConflictDoNothing()
      const [row] = await db.current
        .select({ userId: identities.userId })
        .from(identities)
        .where(and(eq(identities.provider, id), eq(identities.subject, subject)))
        .limit(1)
      if (row?.userId !== user.id) {
        throw new ActionError(`That ${provider.name} account already signs in someone else here.`)
      }
    },

    async unlink(pluginId, id, user, subject) {
      owned(pluginId, id)
      await db.current
        .delete(identities)
        .where(
          and(
            eq(identities.provider, id),
            eq(identities.userId, user.id),
            subject === undefined ? undefined : eq(identities.subject, subject),
          ),
        )
    },
  }
}
