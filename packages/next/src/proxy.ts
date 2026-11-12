import type { Kernel } from '@otwdesign/core'
import type { ProxyHandler } from '@otwdesign/sdk'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * The site's kernel, when this server has booted one: the one booted last, which knows the
 * active plugins, their settings and their services. `null` until the site has answered a
 * request of its own. A proxy never boots a kernel: it runs before every request, and a boot
 * takes a database.
 */
export function bootedKernel(): Kernel | null {
  return (globalThis as typeof globalThis & { __cmsKernel?: Kernel }).__cmsKernel ?? null
}

/**
 * Where this server answers on its own machine, for a proxy that asks the site for a page
 * itself: Next.js's own address for the server, or `fallback` (the request's) where there is
 * none, as on serverless hosts.
 */
export function ownOrigin(fallback: string): string {
  return process.env.__NEXT_PRIVATE_ORIGIN || fallback
}

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
