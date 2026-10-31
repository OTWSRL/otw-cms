import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'

/** A request the supervisor can't take now, such as a second update while one runs. */
export class ControlError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ControlError'
    this.status = status
  }
}

export type ControlHandler = (body: unknown) => unknown | Promise<unknown>

/** `GET /status` and the like: method and path to handler. */
export type ControlRoutes = Readonly<Record<string, ControlHandler>>

const MAX_BODY = 64 * 1024

function authorized(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`)
  const given = Buffer.from(header ?? '')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

async function readJson(incoming: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of incoming as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > MAX_BODY) throw new ControlError(413, 'Request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new ControlError(400, 'Request body is not JSON')
  }
}

/**
 * How the admin reaches the supervisor: JSON over HTTP on a loopback port, with a random token
 * the supervisor hands only to the release it starts. Nothing else on the machine can call it
 * without the token, and nothing off the machine can reach it.
 */
export function createControlServer(token: string, routes: ControlRoutes): Server {
  return createServer(async (incoming, outgoing) => {
    const reply = (status: number, body: unknown) =>
      outgoing
        .writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        .end(JSON.stringify(body))
    if (!authorized(incoming.headers.authorization, token))
      return reply(401, { error: 'Unauthorized' })
    const handler =
      routes[`${incoming.method} ${new URL(incoming.url ?? '/', 'http://x').pathname}`]
    if (!handler) return reply(404, { error: 'Not found' })
    try {
      reply(200, (await handler(await readJson(incoming))) ?? {})
    } catch (error) {
      if (error instanceof ControlError) return reply(error.status, { error: error.message })
      reply(500, { error: error instanceof Error ? error.message : String(error) })
    }
  })
}
