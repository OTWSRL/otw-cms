import { describe, expect, it } from 'vitest'
import { bootKernel, plugin } from './helpers'

/**
 * Behind a reverse proxy (cms serve, nginx, Caddy), Next.js reports every request as
 * http://localhost:<its own port>, whatever the visitor used. These are posts as such an app
 * receives them.
 */
function proxied(
  path: string,
  origin: string,
  headers: Record<string, string> = {},
  method = 'POST',
): Request {
  return new Request(`http://localhost:51234${path}`, {
    method,
    headers: {
      origin,
      'content-type': 'application/x-www-form-urlencoded',
      'x-forwarded-host': 'shop.example',
      'x-forwarded-proto': 'https',
      ...headers,
    },
    body: method === 'GET' ? undefined : 'email=nobody%40shop.example&password=wrong',
  })
}

const LOGIN = '/api/p/core/actions/login'

const echo = plugin('echo', {
  setup(cms) {
    cms.routes.api({ method: 'POST', path: '/ping', handler: () => Response.json({ ok: true }) })
  },
})

describe('origins behind a proxy', () => {
  it('trusts the forwarded host and protocol when told the proxy is trusted', async () => {
    const kernel = await bootKernel({ plugins: [echo], trustProxy: true })
    const login = await kernel.handleApi(
      proxied(LOGIN, 'https://shop.example', { referer: 'https://shop.example/admin/login?x=1' }),
    )
    // Past the origin check: a wrong password goes back to the form, the page it came from.
    expect(login.status).toBe(303)
    expect(login.headers.get('location')).toMatch(/^\/admin\/login\?x=1&flash=/)
    expect(
      (await kernel.handleApi(proxied('/api/p/echo/ping', 'https://shop.example'))).status,
    ).toBe(200)

    // Another site is still another site.
    expect((await kernel.handleApi(proxied(LOGIN, 'https://evil.example'))).status).toBe(403)
    expect(
      (await kernel.handleApi(proxied('/api/p/echo/ping', 'https://evil.example'))).status,
    ).toBe(403)
  })

  it('ignores forwarded headers from a proxy it wasn’t told to trust', async () => {
    const kernel = await bootKernel({ plugins: [echo] })
    expect((await kernel.handleApi(proxied(LOGIN, 'https://shop.example'))).status).toBe(403)
    expect(
      (await kernel.handleApi(proxied('/api/p/echo/ping', 'https://shop.example'))).status,
    ).toBe(403)
  })

  it('accepts the site address from settings, as SITE_URL documents', async () => {
    const kernel = await bootKernel({
      plugins: [echo],
      settings: { 'site.url': 'https://shop.example' },
    })
    expect((await kernel.handleApi(proxied(LOGIN, 'https://shop.example'))).status).toBe(303)
    expect((await kernel.handleApi(proxied(LOGIN, 'https://evil.example'))).status).toBe(403)
  })
})
