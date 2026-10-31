import { spawnSync } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../src/runtime/database'

describe('openDatabase', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cms-db-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('creates a missing data directory on a fresh checkout', async () => {
    const { db, close } = openDatabase({ CMS_DATA_DIR: join(root, '.data', 'pglite') })
    try {
      await expect(db.execute(sql`SELECT 1`)).resolves.toBeDefined()
    } finally {
      await close()
    }
  })

  it('keeps the embedded database to one process, as PGlite can’t share its files', async () => {
    const dir = join(root, '.data', 'pglite')
    const lock = `${dir}.lock`
    await mkdir(join(root, '.data'))
    // The parent process is alive and isn't this one: a running site, say.
    await writeFile(lock, String(process.ppid))
    expect(() => openDatabase({ CMS_DATA_DIR: dir })).toThrow(
      `The embedded database in ${dir} is open in another process (${process.ppid})`,
    )
  })

  it('takes over a lock left by a process that has exited, and releases it on close', async () => {
    const dir = join(root, '.data', 'pglite')
    const lock = `${dir}.lock`
    await mkdir(join(root, '.data'))
    const exited = spawnSync(process.execPath, ['-e', '']).pid!
    await writeFile(lock, String(exited))

    const { close } = openDatabase({ CMS_DATA_DIR: dir })
    expect(await readFile(lock, 'utf8')).toBe(String(process.pid))
    await close()
    await expect(access(lock)).rejects.toThrow('ENOENT')
  })
})
