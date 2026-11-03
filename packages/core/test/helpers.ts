import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database, PluginDefinition } from '@otwdesign/sdk'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { afterEach } from 'vitest'
import { createKernel, type Kernel, type KernelOptions } from '../src/kernel'
import { createMemoryLogger as memoryLogger } from '../src/logger'

export { createMemoryLogger as memoryLogger } from '../src/logger'

const open: PGlite[] = []

const folders: string[] = []

afterEach(async () => {
  await Promise.all(open.splice(0).map((client) => client.close()))
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

/** An empty folder, removed after the test: where a test kernel keeps its uploads. */
export function tempDir(): string {
  const folder = mkdtempSync(join(tmpdir(), 'cms-test-'))
  folders.push(folder)
  return folder
}

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
    uploads: { dir: tempDir() },
    ...options,
  })
}

/** A multipart form post with files, sent with its length, as browsers send forms. */
export async function multipartPost(
  path: string,
  fields: Record<string, string>,
  files: { field: string; name: string; data: Uint8Array; type?: string }[],
  headers: Record<string, string> = {},
): Promise<Request> {
  const form = new FormData()
  for (const [name, value] of Object.entries(fields)) form.append(name, value)
  for (const file of files) {
    form.append(
      file.field,
      new File([new Uint8Array(file.data)], file.name, { type: file.type ?? '' }),
    )
  }
  const encoded = new Response(form)
  const body = new Uint8Array(await encoded.arrayBuffer())
  return new Request(new URL(path, ORIGIN), {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'content-type': encoded.headers.get('content-type')!,
      'content-length': String(body.byteLength),
      ...headers,
    },
    body,
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
