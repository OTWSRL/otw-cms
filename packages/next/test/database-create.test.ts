import type * as ChildProcess from 'node:child_process'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openDatabase } from '../src/runtime/database'

// The processes the database module starts; the next one can be made to fail.
const child = vi.hoisted(() => ({ failNext: false }))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>()
  const execFileSync = vi.fn((...args: Parameters<typeof ChildProcess.execFileSync>) => {
    if (child.failNext) {
      child.failNext = false
      throw Object.assign(new Error('Command failed'), {
        stderr: "Cannot find package '@electric-sql/pglite'",
      })
    }
    return actual.execFileSync(...args)
  })
  return { ...actual, execFileSync }
})

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cms-db-create-'))
  // As a site's server runs, in a directory that depends on PGlite, which this package does.
  // The whole repo's test run starts in its root, which doesn't.
  vi.spyOn(process, 'cwd').mockReturnValue(resolve(import.meta.dirname, '..'))
})

afterEach(async () => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

it('creates a new embedded database in a process of its own, then opens it here', async () => {
  const { execFileSync } = await import('node:child_process')
  const dir = join(root, '.data', 'pglite')

  const { db, close } = openDatabase({ CMS_DATA_DIR: dir })
  try {
    expect(execFileSync).toHaveBeenCalledOnce()
    expect(vi.mocked(execFileSync).mock.calls[0]!.slice(0, 2)).toEqual([
      process.execPath,
      ['--input-type=module', '-e', expect.any(String), dir],
    ])
    await access(join(dir, 'PG_VERSION'))
    await expect(db.execute(sql`SELECT 1`)).resolves.toBeDefined()
  } finally {
    await close()
  }

  // Opened again, it's found made.
  await openDatabase({ CMS_DATA_DIR: dir }).close()
  expect(execFileSync).toHaveBeenCalledOnce()
})

it('creates it in this process when a separate one can’t, and says why', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  child.failNext = true

  const { db, close } = openDatabase({ CMS_DATA_DIR: join(root, 'pglite') })
  try {
    await expect(db.execute(sql`SELECT 1`)).resolves.toBeDefined()
  } finally {
    await close()
  }
  expect(warn).toHaveBeenCalledOnce()
  expect(warn.mock.calls[0]![0]).toContain("Cannot find package '@electric-sql/pglite'")
})
