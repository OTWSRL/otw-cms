import { Agent, createServer, request, type IncomingMessage, type Server } from 'node:http'

const MAINTENANCE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="5"><title>Updating</title></head>
<body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#1d2327">
<h1 style="font-weight:400">This site is being updated.</h1><p>It will be back in a moment.</p>
</body></html>`

/** Hop-by-hop headers belong to one connection and must not be forwarded (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function forwardedHeaders(incoming: IncomingMessage): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(name)) headers[name] = value
  }
  const client = incoming.socket.remoteAddress ?? ''
  const prior = incoming.headers['x-forwarded-for']
  headers['x-forwarded-for'] = prior ? `${String(prior)}, ${client}` : client
  headers['x-forwarded-proto'] ??= 'http'
  // An outer proxy's (nginx terminating TLS, say) says more than ours can.
  headers['x-forwarded-host'] ??= incoming.headers.host ?? ''
  return headers
}

/**
 * The public port. Requests go to the live release's port; between releases (an update on the
 * embedded database, which one process holds at a time) visitors get a short 503 to retry.
 */
export function createProxy(target: () => number | null): Server {
  const agent = new Agent({ keepAlive: true })
  return createServer((incoming, outgoing) => {
    const port = target()
    if (port === null) {
      outgoing
        .writeHead(503, {
          'content-type': 'text/html; charset=utf-8',
          'retry-after': '10',
          'cache-control': 'no-store',
        })
        .end(MAINTENANCE)
      return
    }
    const upstream = request(
      {
        host: '127.0.0.1',
        port,
        method: incoming.method,
        path: incoming.url,
        headers: forwardedHeaders(incoming),
        agent,
      },
      (response) => {
        const headers = Object.fromEntries(
          Object.entries(response.headers).filter(([name]) => !HOP_BY_HOP.has(name)),
        )
        outgoing.writeHead(response.statusCode ?? 502, headers)
        response.pipe(outgoing)
      },
    )
    upstream.on('error', () => {
      if (!outgoing.headersSent) {
        outgoing.writeHead(502, { 'content-type': 'text/plain' }).end('Bad gateway')
      } else {
        outgoing.destroy()
      }
    })
    incoming.pipe(upstream)
  })
}
