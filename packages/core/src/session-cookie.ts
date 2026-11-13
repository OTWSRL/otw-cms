import { SESSION_TTL_MS } from './auth'

/** `__Host-` makes browsers insist on Secure, Path=/ and no Domain, so subdomains can't plant it. */
export const SECURE_SESSION_COOKIE = '__Host-cms_session'
/** Plain-HTTP development, where browsers refuse `__Host-` cookies. */
export const SESSION_COOKIE = 'cms_session'

export const SESSION_COOKIE_NAMES = [SECURE_SESSION_COOKIE, SESSION_COOKIE] as const

const ATTRIBUTES = 'Path=/; HttpOnly; SameSite=Lax'

export function sessionCookie(token: string, secure: boolean): string {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000)
  return secure
    ? `${SECURE_SESSION_COOKIE}=${token}; ${ATTRIBUTES}; Secure; Max-Age=${maxAge}`
    : `${SESSION_COOKIE}=${token}; ${ATTRIBUTES}; Max-Age=${maxAge}`
}

export function clearedSessionCookies(): string[] {
  return [
    `${SECURE_SESSION_COOKIE}=; ${ATTRIBUTES}; Secure; Max-Age=0`,
    `${SESSION_COOKIE}=; ${ATTRIBUTES}; Max-Age=0`,
  ]
}

/** A `Cookie` header's cookies by name. */
export function parseCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>()
  for (const part of header?.split(';') ?? []) {
    const index = part.indexOf('=')
    if (index > 0) cookies.set(part.slice(0, index).trim(), part.slice(index + 1).trim())
  }
  return cookies
}

/** The first of `names` a request carries: the secure cookie, then plain HTTP's. */
export function cookieValue(
  cookies: { get(name: string): string | undefined },
  names: readonly string[],
): string | null {
  for (const name of names) {
    const value = cookies.get(name)
    if (value) return value
  }
  return null
}

/** Reads the session token from a `Cookie` header, preferring the secure cookie. */
export function sessionTokenFromHeader(header: string | null): string | null {
  return header ? cookieValue(parseCookies(header), SESSION_COOKIE_NAMES) : null
}

/** A sign-in a step is holding until its code passes: ten minutes, like the hold itself. */
export const SIGN_IN_COOKIE_NAMES = ['__Host-cms_sign_in', 'cms_sign_in'] as const
/** A browser a sign-in step remembers, so it isn't asked for a code again for a while. */
export const DEVICE_COOKIE_NAMES = ['__Host-cms_device', 'cms_device'] as const

function cookie(
  [secureName, plainName]: readonly [string, string],
  value: string,
  secure: boolean,
  maxAgeSeconds: number,
): string {
  return secure
    ? `${secureName}=${value}; ${ATTRIBUTES}; Secure; Max-Age=${maxAgeSeconds}`
    : `${plainName}=${value}; ${ATTRIBUTES}; Max-Age=${maxAgeSeconds}`
}

export function signInCookie(token: string, secure: boolean, maxAgeSeconds: number): string {
  return cookie(SIGN_IN_COOKIE_NAMES, token, secure, maxAgeSeconds)
}

export function clearedSignInCookies(): string[] {
  return [cookie(SIGN_IN_COOKIE_NAMES, '', true, 0), cookie(SIGN_IN_COOKIE_NAMES, '', false, 0)]
}

export function deviceCookie(token: string, secure: boolean, days: number): string {
  return cookie(DEVICE_COOKIE_NAMES, token, secure, days * 24 * 60 * 60)
}
