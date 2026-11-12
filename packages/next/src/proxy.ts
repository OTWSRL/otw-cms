import type { ProxyHandler } from '@otwdesign/sdk'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * The site's proxy, from its plugins' own: each sees the request in turn, and the first to
 * answer ends it; with no answer the request goes on to the site. `cms generate` writes the
 * `proxy.ts` that calls this, only for a site with a plugin that has one, so other sites have
 * no proxy at all. A site with a proxy of its own calls it from there.
 */
export function createProxy(handlers: readonly ProxyHandler[]) {
  return async function proxy(request: NextRequest): Promise<Response> {
    for (const handler of handlers) {
      const response = await handler(request)
      if (response) return response
    }
    return NextResponse.next()
  }
}
