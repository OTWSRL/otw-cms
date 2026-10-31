import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { ControlError, createControlServer } from '../src/serve/control.ts'
import { createProxy } from '../src/serve/proxy.ts'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  )
})

async function listen(server: Server): Promise<number> {
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

/** A release stand-in that echoes what reached it. */
const release = (name: string) =>
  listen(
    createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => (body += chunk))
      request.on('end', () => {
        response.writeHead(201, { 'content-type': 'application/json', 'x-release': name })
        response.end(
          JSON.stringify({
            url: request.url,
            method: request.method,
            host: request.headers.host,
            forwardedFor: request.headers['x-forwarded-for'],
            forwardedHost: request.headers['x-forwarded-host'],
            body,
          }),
        )
      })
    }),
  )

describe('createProxy', () => {
  it('forwards to the live release, then to the next one, keeping the visitor’s Host', async () => {
    const [blue, green] = [await release('blue'), await release('green')]
    let target: number | null = blue
    const port = await listen(createProxy(() => target))

    const first = await fetch(`http://127.0.0.1:${port}/admin?x=1`, {
      method: 'POST',
      body: 'hello',
    })
    expect(first.status).toBe(201)
    expect(first.headers.get('x-release')).toBe('blue')
    expect(await first.json()).toEqual({
      url: '/admin?x=1',
      method: 'POST',
      // The visitor's Host (the proxy's address), not the release's port.
      host: `127.0.0.1:${port}`,
      forwardedFor: '127.0.0.1',
      forwardedHost: `127.0.0.1:${port}`,
      body: 'hello',
    })

    target = green
    expect((await fetch(`http://127.0.0.1:${port}/`)).headers.get('x-release')).toBe('green')
  })

  it('asks visitors to retry while no release is live', async () => {
    const port = await listen(createProxy(() => null))
    const response = await fetch(`http://127.0.0.1:${port}/shop`)
    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('10')
    expect(await response.text()).toContain('This site is being updated.')
  })

  it('answers 502 when the release is gone', async () => {
    const gone = await listen(createServer())
    servers.pop()!.close()
    const port = await listen(createProxy(() => gone))
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(502)
  })
})

describe('createControlServer', () => {
  const TOKEN = 'a'.repeat(64)
  const control = () =>
    listen(
      createControlServer(TOKEN, {
        'GET /status': () => ({ channel: 'serve' }),
        'POST /update': (body) => ({ notice: `Updating ${JSON.stringify(body)}` }),
        'POST /busy': () => {
          throw new ControlError(409, 'An update is already running.')
        },
        'POST /broken': () => {
          throw new Error('boom')
        },
      }),
    )
  const call = (port: number, route: string, init: RequestInit = {}, token = TOKEN) => {
    const [method, path] = route.split(' ')
    return fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      method,
      headers: { authorization: `Bearer ${token}`, ...init.headers },
    })
  }

  it('answers routes for the token only', async () => {
    const port = await control()
    expect(await (await call(port, 'GET /status')).json()).toEqual({ channel: 'serve' })
    expect((await call(port, 'GET /status', {}, 'b'.repeat(64))).status).toBe(401)
    expect((await call(port, 'GET /status', {}, '')).status).toBe(401)
    expect((await fetch(`http://127.0.0.1:${port}/status`)).status).toBe(401)
    expect((await call(port, 'GET /nope')).status).toBe(404)
  })

  it('passes JSON bodies, and turns errors into answers', async () => {
    const port = await control()
    const update = await call(port, 'POST /update', { body: '{"packages":["@acme/forum"]}' })
    expect(await update.json()).toEqual({ notice: 'Updating {"packages":["@acme/forum"]}' })
    const busy = await call(port, 'POST /busy')
    expect([busy.status, await busy.json()]).toEqual([
      409,
      { error: 'An update is already running.' },
    ])
    expect((await call(port, 'POST /broken')).status).toBe(500)
    expect((await call(port, 'POST /update', { body: '{oops' })).status).toBe(400)
    expect((await call(port, 'POST /update', { body: 'x'.repeat(70_000) })).status).toBe(413)
  })
})
