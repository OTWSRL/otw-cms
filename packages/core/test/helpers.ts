import type { Database, PluginDefinition } from '@cms/sdk'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { afterEach } from 'vitest'
import { createKernel, type Kernel, type KernelOptions } from '../src/kernel'
import { createMemoryLogger as memoryLogger } from '../src/logger'

export { createMemoryLogger as memoryLogger } from '../src/logger'

const open: PGlite[] = []

afterEach(async () => {
  await Promise.all(open.splice(0).map((client) => client.close()))
})

// initdb takes most of a second; restoring an empty cluster from a dump takes about 100 ms.
const template = await (async () => {
  const client = new PGlite()
  // dumpDataDir() never settles if it runs before startup finishes.
  await client.waitReady
  const dump = await client.dumpDataDir('none')
  await client.close()
  return dump
})()

/** A fresh in-memory Postgres, closed automatically after each test. */
export function createDb(): Database {
  const client = new PGlite({ loadDataDir: template })
  open.push(client)
  return drizzle(client)
}

export function plugin(id: string, extra: Partial<PluginDefinition> = {}): PluginDefinition {
  return { id, version: '1.0.0', ...extra }
}

export const ORIGIN = 'http://cms.test'

/** A same-origin browser form post, unless the headers say otherwise. */
export function formPost(
  path: string,
  fields: Record<string, string | readonly string[]>,
  headers: Record<string, string> = {},
): Request {
  const body = new URLSearchParams()
  for (const [name, value] of Object.entries(fields)) {
    for (const item of typeof value === 'string' ? [value] : value) body.append(name, item)
  }
  return new Request(new URL(path, ORIGIN), {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'content-type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    body: body.toString(),
  })
}

export const PASSWORD = 'correct horse battery staple'

export function bootKernel(options: Partial<KernelOptions> & Pick<KernelOptions, 'plugins'>) {
  return createKernel({
    db: createDb(),
    logger: memoryLogger(),
    strict: true,
    passwordHashing: 'fast',
    ...options,
  })
}

let users = 0

/** A user with `role` and a session cookie for `formPost()`. */
export async function signIn(kernel: Kernel, role = 'administrator') {
  const user = await kernel.auth.createUser({
    email: `${role}-${++users}@cms.test`,
    role,
    password: PASSWORD,
  })
  return { user, cookie: `cms_session=${await kernel.auth.createSession(user.id)}` }
}

/** Where a redirect points, and the flash message it carries. */
export function redirectOf(kernel: Kernel, response: Response) {
  const url = new URL(response.headers.get('location') ?? '', ORIGIN)
  const flash = kernel.readFlash(url.searchParams.get('flash') ?? undefined)
  url.searchParams.delete('flash')
  return { status: response.status, path: url.pathname + url.search, flash }
}

/** `name=value` pairs from a response's Set-Cookie headers. */
export function cookiesFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0]!)
    .join('; ')
}
