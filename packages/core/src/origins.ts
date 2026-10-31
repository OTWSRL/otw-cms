/**
 * Which origins are this site. Behind a reverse proxy (cms serve, nginx, Caddy) Next.js reports
 * every request as http://localhost:<its own port>, whatever the visitor used, so the visitor's
 * origin comes from the proxy's X-Forwarded-Host and X-Forwarded-Proto, but only from a proxy
 * the site was told to trust: anyone can send those headers to a server that faces the internet.
 */
export interface OriginPolicy {
  /** Read X-Forwarded-Host and -Proto: set when a trusted proxy sits in front. */
  trustProxy: boolean
  /** `site.url`, the public address an administrator configured. */
  siteUrl(): string | undefined
  /** Other sites allowed to post, such as a separate storefront. */
  allowedOrigins: readonly string[]
}

function first(header: string | null): string | undefined {
  return header?.split(',')[0]?.trim() || undefined
}

/** The origin the visitor used, as far as this request can tell. */
export function publicOrigin(request: Request, trustProxy: boolean): string {
  const url = new URL(request.url)
  const host = trustProxy ? first(request.headers.get('x-forwarded-host')) : undefined
  if (!host) return url.origin
  const proto = first(request.headers.get('x-forwarded-proto')) === 'https' ? 'https' : 'http'
  try {
    return new URL(`${proto}://${host}`).origin
  } catch {
    return url.origin
  }
}

function originOf(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    return new URL(value).origin
  } catch {
    return undefined
  }
}

/** Whether an Origin (or a Referer's origin) is this site. */
export function isSiteOrigin(origin: string, request: Request, policy: OriginPolicy): boolean {
  return (
    origin === publicOrigin(request, policy.trustProxy) ||
    origin === new URL(request.url).origin ||
    origin === originOf(policy.siteUrl()) ||
    policy.allowedOrigins.includes(origin)
  )
}
