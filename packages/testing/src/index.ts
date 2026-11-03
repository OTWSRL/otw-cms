import {
  ADMINISTRATOR,
  createKernel,
  createMemoryLogger,
  registerTracerProvider,
  SESSION_COOKIE,
  traceQueries,
  TraceCollector,
  type Kernel,
  type KernelOptions,
  type MemoryLogger,
} from '@otwdesign/core'
import type { Database, User } from '@otwdesign/sdk'
import { PGlite } from '@electric-sql/pglite'
import { trace } from '@opentelemetry/api'
import { drizzle } from 'drizzle-orm/pglite'

export { createMemoryLogger, type LogEntry, type MemoryLogger } from '@otwdesign/core'

/** A booted kernel on its own database, with helpers to sign in and send requests. */
export interface TestKernel {
  /** The current kernel; replaced by `reboot()`. */
  kernel: Kernel
  db: Database
  logger: MemoryLogger
  /** Builds a request against the kernel's API, with JSON or form bodies encoded for you. */
  request(method: string, path: string, init?: TestRequestInit): Promise<Response>
  /** Creates a user with `role` and a session; pass `cookie` to `request()` to act as them. */
  signIn(role?: string): Promise<{ user: User; cookie: string }>
  /** Boots a fresh kernel on the same database, as the app does after an admin change. */
  reboot(): Promise<Kernel>
  /**
   * With `tracing: true`, the collector that records requests: `request()` and `inRequest()`
   * run inside a request span, as Next.js runs requests.
   */
  traces: TraceCollector | undefined
  /** Runs `fn` as one request (traced, with `tracing: true`) and returns the trace id, if any. */
  inRequest(path: string, fn: () => Promise<unknown>): Promise<string | undefined>
  close(): Promise<void>
}

/** A request's body, headers and cookie. `json` and `form` set the content type. */
export interface TestRequestInit {
  json?: unknown
  form?: Record<string, string>
  body?: string
  headers?: Record<string, string>
  /** Sent as the `Cookie` header, e.g. from `signIn()`. */
  cookie?: string
}

/** The site's origin in tests. Requests are sent to it, and unsafe ones carry it as `Origin`. */
export const TEST_ORIGIN = 'http://cms.test'
/** The password `signIn()` gives the users it creates, for tests that sign in through the form. */
export const TEST_PASSWORD = 'correct horse battery staple'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

// initdb takes most of a second; restoring an empty cluster from a dump takes about 100 ms.
let template: Promise<File | Blob> | undefined
function emptyCluster(): Promise<File | Blob> {
  template ??= (async () => {
    const client = new PGlite()
    // dumpDataDir() never settles if it runs before startup finishes.
    await client.waitReady
    const dump = await client.dumpDataDir('none')
    await client.close()
    return dump
  })()
  return template
}

/**
 * Boots the kernel on a fresh in-memory Postgres with migrations applied. Strict by default, so
 * a broken plugin fails the test instead of being skipped, and with fast password hashing.
 */
export async function createTestKernel(
  options: Omit<KernelOptions, 'db' | 'logger' | 'traces'> & {
    /** Record every request, as a site does while a plugin has enabled tracing. */
    tracing?: boolean
  },
): Promise<TestKernel> {
  const { tracing = false, ...kernelOptions } = options
  const client = new PGlite({ loadDataDir: await emptyCluster() })
  const traces = tracing ? testCollector() : undefined
  const db = drizzle(traces ? tracePglite(client) : client)
  const logger = createMemoryLogger()
  const boot = async () => {
    const kernel = await createKernel({
      strict: true,
      passwordHashing: 'fast',
      ...kernelOptions,
      db,
      logger,
      traces,
    })
    // Tests of a plugin's own spans record whether or not a plugin under test enables tracing.
    traces?.setEnabled(true)
    return kernel
  }
  const inRequest = async <T>(path: string, method: string, fn: () => Promise<T>) =>
    !traces
      ? { result: await fn(), id: undefined }
      : tracer().startActiveSpan(
          `${method} ${path}`,
          { attributes: { 'http.method': method, 'http.target': path } },
          async (root) => {
            try {
              const result = await fn()
              if (result instanceof Response) root.setAttribute('http.status_code', result.status)
              return { result, id: root.spanContext().traceId }
            } finally {
              root.end()
            }
          },
        )
  let users = 0

  try {
    const harness: TestKernel = {
      kernel: await boot(),
      db,
      logger,
      request: async (method, path, init = {}) =>
        (
          await inRequest(path, method, () =>
            harness.kernel.handleApi(buildRequest(method, path, init)),
          )
        ).result,
      traces,
      inRequest: async (path, fn) => (await inRequest(path, 'GET', fn)).id,
      async signIn(role = ADMINISTRATOR) {
        const user = await harness.kernel.auth.createUser({
          email: `${role}-${++users}@cms.test`,
          name: role,
          role,
          password: TEST_PASSWORD,
        })
        const token = await harness.kernel.auth.createSession(user.id)
        return { user, cookie: `${SESSION_COOKIE}=${token}` }
      },
      async reboot() {
        harness.kernel = await boot()
        return harness.kernel
      },
      close: () => client.close(),
    }
    return harness
  } catch (error) {
    await client.close()
    throw error
  }
}

const tracer = () => trace.getTracer('otw-testing')
let collector: TraceCollector | undefined

/** One provider per test process, as one per server process; registered on first use. */
function testCollector(): TraceCollector {
  if (!collector) {
    collector = new TraceCollector()
    registerTracerProvider(collector)
  }
  return collector
}

function tracePglite(client: PGlite): PGlite {
  traceQueries(client)
  const transaction = client.transaction.bind(client)
  client.transaction = ((fn: Parameters<PGlite['transaction']>[0]) =>
    transaction((tx) => fn(traceQueries(tx)))) as PGlite['transaction']
  return client
}

/**
 * Unsafe requests carry this site's Origin, as a browser's would. Override it to test CSRF, or
 * pass `origin: ''` to send none (server-to-server calls such as webhooks).
 */
function buildRequest(method: string, path: string, init: TestRequestInit): Request {
  const headers = new Headers(init.headers)
  if (!SAFE_METHODS.has(method.toUpperCase()) && !headers.has('origin')) {
    headers.set('origin', TEST_ORIGIN)
  }
  if (headers.get('origin') === '') headers.delete('origin')
  if (init.cookie) headers.set('cookie', init.cookie)
  let body: string | undefined = init.body
  if (init.json !== undefined) {
    headers.set('content-type', 'application/json')
    body = JSON.stringify(init.json)
  } else if (init.form) {
    headers.set('content-type', 'application/x-www-form-urlencoded')
    body = new URLSearchParams(init.form).toString()
  }
  return new Request(new URL(path, TEST_ORIGIN), { method, headers, body })
}
