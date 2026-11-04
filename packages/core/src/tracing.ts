import {
  context,
  isSpanContextValid,
  ProxyTracerProvider,
  SpanKind,
  SpanStatusCode,
  trace,
  TraceFlags,
  type Attributes,
  type HrTime,
} from '@opentelemetry/api'
// Types only: the SDK loads once a plugin turns tracing on (see registerTracerProvider).
import type {
  ReadableSpan,
  Sampler,
  SamplingDecision,
  Span,
  SpanProcessor,
} from '@opentelemetry/sdk-trace'
import type { RequestTrace, TraceSpan, TraceSpanKind } from '@otwdesign/sdk'

// Asked for when a span starts, not when this module loads: a tracer taken before the site's
// instrumentation registers its provider, from another copy of the API, would never record.
const tracer = () => trace.getTracer('otw-cms')

/**
 * Runs `fn` in a span of its own when the current request is being traced, and as it is
 * otherwise: when nothing records, this costs one context lookup.
 */
export function traced<T>(
  name: string,
  attributes: Attributes,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  if (!trace.getActiveSpan()?.isRecording()) return fn()
  return tracer().startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn()
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      })
      throw error
    } finally {
      span.end()
    }
  })
}

const MAX_STATEMENT = 2000

/** A driver's query method: PGlite's `query(sql, params)`, or pg's `query(config | text, values)`. */
type QueryMethod = (...args: never[]) => Promise<unknown>

/**
 * Replaces `target.query` with one that records each query in a span of the current request:
 * the statement, how many parameters (never their values), the row count and how long it took.
 */
export function traceQueries<T extends { query: QueryMethod }>(target: T): T {
  const query = target.query.bind(target) as (...args: unknown[]) => Promise<unknown>
  target.query = ((...args: unknown[]) => {
    const [first, second] = args
    // Callback-style calls (pg's legacy form) run untraced.
    if (!trace.getActiveSpan()?.isRecording() || args.some((arg) => typeof arg === 'function')) {
      return query(...args)
    }
    const text =
      typeof first === 'string' ? first : String((first as { text?: unknown })?.text ?? '')
    const params = Array.isArray(second) ? second : (first as { values?: unknown[] })?.values
    return tracer().startActiveSpan(
      'db.query',
      {
        kind: SpanKind.CLIENT,
        attributes: {
          'otw.kind': 'query',
          'db.system': 'postgresql',
          'db.statement': text.length > MAX_STATEMENT ? `${text.slice(0, MAX_STATEMENT)}…` : text,
          'db.params': params?.length ?? 0,
        },
      },
      async (span) => {
        try {
          const result = (await query(...args)) as { rows?: unknown[]; rowCount?: number | null }
          span.setAttribute(
            'db.rows',
            Array.isArray(result?.rows) ? result.rows.length : (result?.rowCount ?? 0),
          )
          return result
        } catch (error) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : String(error),
          })
          throw error
        } finally {
          span.end()
        }
      },
    )
  }) as T['query']
  return target
}

/** The id of the trace the current request is recorded in, if it is being recorded. */
export function currentTraceId(): string | undefined {
  const span = trace.getActiveSpan()
  return span?.isRecording() ? span.spanContext().traceId : undefined
}

const MAX_SPANS = 2000
const MAX_KEPT = 100
const KEPT_FOR_MS = 10 * 60_000
// Requests in flight at once; past this, the oldest are forgotten rather than growing forever.
const MAX_PENDING = 1000
const MAX_ATTRIBUTES = 30
const MAX_VALUE = 2000

interface Recorded {
  root: Span | ReadableSpan
  spans: ReadableSpan[]
  dropped: number
  kept: boolean
  /** Set when the request's root span ends. */
  ended?: { memory: RequestTrace['memory'] }
  keptAt?: number
}

const toMs = ([seconds, nanos]: HrTime) => seconds * 1e3 + nanos / 1e6

// SamplingDecision's values, which the SDK defines.
const NOT_RECORD = 0 as SamplingDecision
const RECORD_AND_SAMPLED = 2 as SamplingDecision

/** Loads the SDK and installs it behind a registered provider, once per collector. */
const installers = new WeakMap<TraceCollector, () => Promise<void>>()

// Next.js's span types, by what they time.
const NEXT_KINDS: Record<string, TraceSpanKind> = {
  'BaseServer.handleRequest': 'request',
  'AppRender.getBodyResult': 'render',
  'AppRender.fetch': 'other',
  'ResolveMetadata.generateMetadata': 'render',
  'NextNodeServer.findPageComponents': 'render',
  'AppRouteRouteHandlers.runHandler': 'api',
}

const KINDS = new Set<TraceSpanKind>([
  'request',
  'render',
  'query',
  'hook',
  'page',
  'admin',
  'api',
  'boot',
  'setup',
  'migration',
  'other',
])

function kindOf(span: ReadableSpan, isRoot: boolean): TraceSpanKind {
  if (isRoot) return 'request'
  const own = span.attributes['otw.kind']
  if (typeof own === 'string' && KINDS.has(own as TraceSpanKind)) return own as TraceSpanKind
  const next = span.attributes['next.span_type']
  return (typeof next === 'string' && NEXT_KINDS[next]) || 'other'
}

function plainAttributes(span: ReadableSpan): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(span.attributes).slice(0, MAX_ATTRIBUTES)) {
    if (value === undefined || value === null) continue
    const plain = Array.isArray(value) ? value.join(', ') : value
    out[key] =
      typeof plain === 'string' && plain.length > MAX_VALUE
        ? `${plain.slice(0, MAX_VALUE)}…`
        : plain
  }
  return out
}

function errorOf(span: ReadableSpan): string | undefined {
  if (span.status.code !== SpanStatusCode.ERROR) return undefined
  const exception = span.events.find((event) => event.name === 'exception')
  const message = exception?.attributes?.['exception.message']
  return span.status.message || (typeof message === 'string' ? message : 'Failed')
}

function attribute(span: Span | ReadableSpan, ...keys: string[]): string | number | null {
  for (const key of keys) {
    const value = span.attributes[key]
    if (typeof value === 'string' || typeof value === 'number') return value
  }
  return null
}

function buildTrace(id: string, recorded: Recorded): RequestTrace {
  const { root } = recorded
  const start = toMs(root.startTime)
  const rootId = root.spanContext().spanId
  const byId = new Map(recorded.spans.map((span) => [span.spanContext().spanId, span]))
  const parentOf = (span: ReadableSpan) =>
    span.parentSpanContext ? byId.get(span.parentSpanContext.spanId) : undefined
  const pluginOf = (span: ReadableSpan | undefined): string | null => {
    for (let at = span, depth = 0; at && depth < 100; depth++) {
      const plugin = at.attributes['otw.plugin']
      if (typeof plugin === 'string') return plugin
      at = parentOf(at)
    }
    return null
  }
  const depthOf = (span: ReadableSpan): number => {
    let depth = 0
    for (let at = parentOf(span); at && depth < 100; at = parentOf(at)) depth++
    return depth
  }
  const spans: TraceSpan[] = recorded.spans
    .map((span) => ({ span, at: Math.max(0, toMs(span.startTime) - start), depth: depthOf(span) }))
    // Start times are whole milliseconds, so a span and those it starts often tie: parents first.
    .sort((a, b) => a.at - b.at || a.depth - b.depth)
    .map(({ span, at }) => {
      const error = errorOf(span)
      return {
        id: span.spanContext().spanId,
        parentId: span.parentSpanContext?.spanId ?? null,
        name: span.name,
        kind: kindOf(span, span.spanContext().spanId === rootId),
        start: at,
        duration: toMs(span.duration),
        plugin: pluginOf(span),
        attributes: plainAttributes(span),
        ...(error ? { error } : {}),
      }
    })
  const method = attribute(root, 'http.method', 'http.request.method')
  const status = attribute(root, 'http.status_code', 'http.response.status_code')
  return {
    id,
    method: typeof method === 'string' ? method : root.name.split(' ')[0] || 'GET',
    route: (attribute(root, 'next.route', 'http.route') as string | null) ?? null,
    path: (attribute(root, 'http.target', 'url.path') as string | null) ?? null,
    status: typeof status === 'number' ? status : status ? Number(status) : null,
    startedAt: start,
    duration: recorded.ended ? toMs((root as ReadableSpan).duration) : null,
    memory: recorded.ended?.memory ?? null,
    spans,
    droppedSpans: recorded.dropped,
  }
}

/**
 * Collects each request's spans into a trace. Requests are recorded only while a plugin has
 * enabled tracing, and kept only when a plugin asks (for a request someone may inspect); the
 * rest are dropped when they end.
 */
export class TraceCollector implements SpanProcessor {
  #enabled = false
  #installed?: Promise<void>
  readonly #recording = new Map<string, Recorded>()
  readonly #kept = new Map<string, Recorded>()

  /**
   * Records a request only while tracing is enabled; spans inside it follow their request, as
   * the SDK's ParentBasedSampler has them.
   */
  readonly sampler: Sampler = {
    shouldSample: (parentContext) => {
      const parent = trace.getSpanContext(parentContext)
      const sampled =
        parent && isSpanContextValid(parent)
          ? (parent.traceFlags & TraceFlags.SAMPLED) === TraceFlags.SAMPLED
          : this.#enabled
      return { decision: sampled ? RECORD_AND_SAMPLED : NOT_RECORD }
    },
    toString: () => 'OtwCmsSampler',
  }

  get enabled(): boolean {
    return this.#enabled
  }

  /**
   * Turns recording on or off. Turned on for the first time, it loads OpenTelemetry's SDK when
   * the collector was registered with `registerTracerProvider()`; the promise settles once
   * requests can be recorded.
   */
  setEnabled(enabled: boolean): Promise<void> {
    this.#enabled = enabled
    const install = installers.get(this)
    if (!enabled || !install) return Promise.resolve()
    this.#installed ??= install()
    return this.#installed
  }

  keep(id: string): void {
    const recorded = this.#recording.get(id)
    if (recorded) recorded.kept = true
  }

  get(id: string): RequestTrace | undefined {
    this.#expire()
    const recorded = this.#kept.get(id) ?? this.#recording.get(id)
    return recorded?.kept ? buildTrace(id, recorded) : undefined
  }

  /** Kept traces, newest first: those finished, then those still running. */
  list(): RequestTrace[] {
    this.#expire()
    const running = [...this.#recording].filter(([, recorded]) => recorded.kept)
    return [...this.#kept, ...running].map(([id, recorded]) => buildTrace(id, recorded)).reverse()
  }

  onStart(span: Span): void {
    if (span.parentSpanContext) return
    const { traceId } = span.spanContext()
    if (this.#recording.size >= MAX_PENDING) {
      const oldest = this.#recording.keys().next().value
      if (oldest !== undefined) this.#recording.delete(oldest)
    }
    this.#recording.set(traceId, { root: span, spans: [], dropped: 0, kept: false })
  }

  onEnd(span: ReadableSpan): void {
    const { traceId, spanId } = span.spanContext()
    const recorded = this.#recording.get(traceId) ?? this.#kept.get(traceId)
    if (!recorded) return
    if (recorded.spans.length < MAX_SPANS) recorded.spans.push(span)
    else recorded.dropped++
    if (spanId !== recorded.root.spanContext().spanId) return

    this.#recording.delete(traceId)
    recorded.root = span
    if (!recorded.kept) return
    const { heapUsed, rss } = process.memoryUsage()
    recorded.ended = { memory: { heapUsed, rss } }
    recorded.keptAt = Date.now()
    this.#kept.set(traceId, recorded)
    this.#expire()
  }

  #expire(): void {
    const cutoff = Date.now() - KEPT_FOR_MS
    for (const [id, recorded] of this.#kept) {
      if (this.#kept.size > MAX_KEPT || (recorded.keptAt ?? 0) < cutoff) this.#kept.delete(id)
      else break
    }
  }

  forceFlush(): Promise<void> {
    return Promise.resolve()
  }

  shutdown(): Promise<void> {
    this.#recording.clear()
    this.#kept.clear()
    return Promise.resolve()
  }
}

/**
 * Makes `collector` the process's OpenTelemetry tracer provider, with the context manager spans
 * need to nest. Returns false, changing nothing, when another provider was registered first.
 *
 * What's registered here is a stand-in: the SDK, about 25 MB, loads only once the collector is
 * enabled, so a site with no plugin that traces never loads it. Until then, spans are no-ops.
 *
 * No propagator: a `traceparent` header on an incoming request is ignored, so every request is
 * a root of its own, recorded only when the collector's sampler says so. With one, anyone could
 * have a request recorded by sending a sampled header, and the collector, which collects roots,
 * would miss requests from proxies that add one.
 */
export function registerTracerProvider(collector: TraceCollector): boolean {
  const provider = new ProxyTracerProvider()
  if (!trace.setGlobalTracerProvider(provider)) return false
  installers.set(collector, async () => {
    const [{ TracerProvider }, { AsyncLocalStorageContextManager }] = await Promise.all([
      import('@opentelemetry/sdk-trace'),
      import('@opentelemetry/context-async-hooks'),
    ])
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
    provider.setDelegate(
      new TracerProvider({ sampler: collector.sampler, spanProcessors: [collector] }),
    )
  })
  return true
}
