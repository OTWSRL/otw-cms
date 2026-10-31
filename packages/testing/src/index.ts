import {
  ADMINISTRATOR,
  createKernel,
  createMemoryLogger,
  SESSION_COOKIE,
  type Kernel,
  type KernelOptions,
  type MemoryLogger,
} from '@cms/core'
import type { Database, User } from '@cms/sdk'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

export { createMemoryLogger, type LogEntry, type MemoryLogger } from '@cms/core'

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
  close(): Promise<void>
}

export interface TestRequestInit {
  json?: unknown
  form?: Record<string, string>
  body?: string
  headers?: Record<string, string>
  /** Sent as the `Cookie` header, e.g. from `signIn()`. */
  cookie?: string
}

export const TEST_ORIGIN = 'http://cms.test'
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
  options: Omit<KernelOptions, 'db' | 'logger'>,
): Promise<TestKernel> {
  const client = new PGlite({ loadDataDir: await emptyCluster() })
  const db = drizzle(client)
  const logger = createMemoryLogger()
  const boot = () => createKernel({ strict: true, passwordHashing: 'fast', ...options, db, logger })
  let users = 0

  try {
    const harness: TestKernel = {
      kernel: await boot(),
      db,
      logger,
      request: (method, path, init = {}) =>
        harness.kernel.handleApi(buildRequest(method, path, init)),
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
