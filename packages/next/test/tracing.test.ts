import { PGlite } from '@electric-sql/pglite'
import { propagation, ROOT_CONTEXT, trace } from '@opentelemetry/api'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { describe, expect, it } from 'vitest'
import { tracedPglite } from '../src/runtime/database'
import { registerTracing, traceCollector } from '../src/runtime/tracing'

describe('registerTracing', () => {
  it('installs one collector per process, recording nothing until a plugin enables it', () => {
    const collector = registerTracing()!
    expect(registerTracing()).toBe(collector)
    expect(traceCollector()).toBe(collector)
    expect(collector.enabled).toBe(false)
  })

  it('records the embedded database’s queries, inside transactions too', async () => {
    const collector = registerTracing()!
    collector.setEnabled(true)
    const db = drizzle(tracedPglite(new PGlite()))
    const id = await trace.getTracer('test').startActiveSpan('GET /', async (root) => {
      collector.keep(root.spanContext().traceId)
      await db.execute(sql`SELECT 1`)
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT 2`)
      })
      root.end()
      return root.spanContext().traceId
    })
    const statements = collector
      .get(id)!
      .spans.filter((span) => span.kind === 'query')
      .map((span) => span.attributes['db.statement'])
    expect(statements).toEqual(expect.arrayContaining(['SELECT 1', 'SELECT 2']))
  })

  it('treats each request as its own, whatever trace context it arrives with', () => {
    const collector = registerTracing()!
    // A sampled W3C traceparent header, as a visitor or a proxy could send.
    const remote = '0af7651916cd43dd8448eb211c80319c'
    const incoming = propagation.extract(ROOT_CONTEXT, {
      traceparent: `00-${remote}-b7ad6b7169203331-01`,
    })
    const tracer = trace.getTracer('test')

    collector.setEnabled(false)
    const ignored = tracer.startSpan('GET /', {}, incoming)
    expect(ignored.isRecording()).toBe(false)
    ignored.end()

    collector.setEnabled(true)
    const recorded = tracer.startSpan('GET /', {}, incoming)
    const id = recorded.spanContext().traceId
    collector.keep(id)
    recorded.end()
    expect(id).not.toBe(remote)
    expect(collector.get(id)).toMatchObject({ id, method: 'GET' })
  })
})
