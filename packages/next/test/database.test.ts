import { spawn, spawnSync } from 'node:child_process'
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
    expect((await readFile(lock, 'utf8')).split(' ')[0]).toBe(String(process.pid))
    await close()
    await expect(access(lock)).rejects.toThrow('ENOENT')
  })

  it('takes over a lock whose process id now belongs to another process, as after a restart', async () => {
    const dir = join(root, '.data', 'pglite')
    const lock = `${dir}.lock`
    await mkdir(join(root, '.data'))
    // The id is alive (this test's parent), but that process started long after the lock's did:
    // a container that restarted gives its processes the same low ids again.
    await writeFile(lock, `${process.ppid} ${Date.now() - 3_600_000}`)

    const { close } = openDatabase({ CMS_DATA_DIR: dir })
    expect((await readFile(lock, 'utf8')).split(' ')[0]).toBe(String(process.pid))
    await close()
  })

  it('keeps a lock while the process that took it is running', async () => {
    const dir = join(root, '.data', 'pglite')
    const lock = `${dir}.lock`
    await mkdir(join(root, '.data'))
    // Another process takes the lock as openDatabase() writes it, and stays.
    const holder = spawn(process.execPath, [
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(lock)}, process.pid + ' ' + Math.round(Date.now() - process.uptime() * 1000)); setInterval(() => {}, 1000)`,
    ])
    try {
      await expect.poll(() => readFile(lock, 'utf8').catch(() => '')).toMatch(/^\d+ \d+$/)
      expect(() => openDatabase({ CMS_DATA_DIR: dir })).toThrow(
        `is open in another process (${holder.pid})`,
      )
    } finally {
      holder.kill()
    }
  })

  it('gives the embedded database 16 MB of shared buffers, or what CMS_SHARED_BUFFERS says', async () => {
    const shown = async (env: Record<string, string>) => {
      const { db, close } = openDatabase({ CMS_DATA_DIR: join(root, 'pglite'), ...env })
      try {
        const result = (await db.execute(sql`SHOW shared_buffers`)) as {
          rows: { shared_buffers: string }[]
        }
        return result.rows[0]!.shared_buffers
      } finally {
        await close()
      }
    }
    expect(await shown({})).toBe('16MB')
    expect(await shown({ CMS_SHARED_BUFFERS: '64MB' })).toBe('64MB')
  })

  it('refuses a CMS_SHARED_BUFFERS that isn’t a size, before touching the database', async () => {
    const dir = join(root, 'pglite')
    expect(() => openDatabase({ CMS_DATA_DIR: dir, CMS_SHARED_BUFFERS: 'lots' })).toThrow(
      'CMS_SHARED_BUFFERS must be a size such as 16MB or 128MB, not "lots".',
    )
    await expect(access(`${dir}.lock`)).rejects.toThrow('ENOENT')
  })
})
