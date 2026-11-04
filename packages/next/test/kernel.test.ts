import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

let root: string
const env = { ...process.env }

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cms-kernel-'))
  process.env.CMS_DATA_DIR = join(root, 'pglite')
  delete process.env.DATABASE_URL
})

afterEach(async () => {
  process.env = { ...env }
  await rm(root, { recursive: true, force: true })
})

it('opens the database again on the next request after an open failed', async () => {
  const { defineSite } = await import('../src/site-registry')
  const { getKernel } = await import('../src/runtime/kernel')
  defineSite({ plugins: [] })

  // Another live process holds the embedded database: this server's parent, say.
  const lock = join(root, 'pglite.lock')
  await writeFile(lock, String(process.ppid))
  // As server components and route handlers call it.
  const request = async () => getKernel()
  await expect(request()).rejects.toThrow('is open in another process')

  // That process stops; the next request gets a kernel rather than the first error again.
  await rm(lock)
  const kernel = await request()
  expect(kernel.setting('site.title')).toBeDefined()
})
