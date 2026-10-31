import { HttpError } from '@cms/sdk'
import { describe, expect, it } from 'vitest'
import { createKernel } from '../src/kernel'
import { createDb, memoryLogger, plugin } from './helpers'

const BASE = 'https://shop.test'

async function bootApi(allowedOrigins?: string[]) {
  const logger = memoryLogger()
  const kernel = await createKernel({
    db: createDb(),
    logger,
    strict: true,
    allowedOrigins,
    plugins: [
      plugin('orders', {
        setup(cms) {
          cms.routes.api({
            method: 'GET',
            path: '/orders/:id',
            handler: (_req, { params }) => Response.json({ id: params.id }),
          })
          cms.routes.api({
            method: 'POST',
            path: '/orders',
            handler: () => new Response(null, { status: 201 }),
          })
          cms.routes.api({
            method: 'POST',
            path: '/invalid',
            handler: () => {
              throw new HttpError(422, 'Quantity must be positive', { field: 'quantity' })
            },
          })
          cms.routes.api({
            method: 'POST',
            path: '/crash',
            handler: () => {
              throw new Error('secret connection string leaked')
            },
          })
          cms.routes.api({ method: 'GET', path: '/not-a-response', handler: () => 'oops' as never })
        },
      }),
    ],
  })
  return { kernel, logger }
}

const request = (method: string, path: string, headers: Record<string, string> = {}) =>
  new Request(`${BASE}${path}`, { method, headers })

describe('kernel.handleApi', () => {
  it('dispatches to the plugin route with params', async () => {
    const { kernel } = await bootApi()
    const response = await kernel.handleApi(request('GET', '/api/p/orders/orders/42'))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: '42' })
  })

  it('returns 404 for unknown paths and 405 with Allow for the wrong method', async () => {
    const { kernel } = await bootApi()
    expect((await kernel.handleApi(request('GET', '/api/p/nobody/here'))).status).toBe(404)
    const response = await kernel.handleApi(request('DELETE', '/api/p/orders/orders'))
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('POST')
  })

  it('blocks cross-origin unsafe requests but allows same-origin, listed and server-to-server ones', async () => {
    const { kernel } = await bootApi(['https://admin.test'])
    const post = (origin?: string) =>
      kernel.handleApi(request('POST', '/api/p/orders/orders', origin ? { origin } : {}))
    expect((await post('https://evil.test')).status).toBe(403)
    expect((await post(BASE)).status).toBe(201)
    expect((await post('https://admin.test')).status).toBe(201)
    expect((await post()).status).toBe(201)
  })

  it('turns HttpError into a JSON error with its status and details', async () => {
    const { kernel } = await bootApi()
    const response = await kernel.handleApi(request('POST', '/api/p/orders/invalid'))
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      error: 'Quantity must be positive',
      details: { field: 'quantity' },
    })
  })

  it('logs unexpected errors with context but never leaks them to the client', async () => {
    const { kernel, logger } = await bootApi()
    const response = await kernel.handleApi(request('POST', '/api/p/orders/crash'))
    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('secret')
    expect(logger.entries.find((e) => e.level === 'error')?.context).toMatchObject({
      plugin: 'orders',
      route: 'orders POST /crash',
    })
  })

  it('treats a handler that returns something other than a Response as a server error', async () => {
    const { kernel } = await bootApi()
    expect((await kernel.handleApi(request('GET', '/api/p/orders/not-a-response'))).status).toBe(
      500,
    )
  })
})
