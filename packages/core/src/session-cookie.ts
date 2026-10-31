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

/** Reads the session token from a `Cookie` header, preferring the secure cookie. */
export function sessionTokenFromHeader(header: string | null): string | null {
  if (!header) return null
  const cookies = new Map<string, string>()
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index > 0) cookies.set(part.slice(0, index).trim(), part.slice(index + 1).trim())
  }
  for (const name of SESSION_COOKIE_NAMES) {
    const value = cookies.get(name)
    if (value) return value
  }
  return null
}
