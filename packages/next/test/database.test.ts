import { spawn, spawnSync } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import type { Pool } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, supabasePoolerUrl } from '../src/runtime/database'

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
    // The parent process is alive, isn't this one, and was running when the lock was written: a
    // running site, say, whose lock is from before start times were kept.
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

  it('takes over a lock from before start times were kept, when its id now names a newer process', async () => {
    const dir = join(root, '.data', 'pglite')
    const lock = `${dir}.lock`
    await mkdir(join(root, '.data'))
    // A 1.0 site's lock, an hour old, upgraded into a new container where its id is now another
    // process (this test's parent), one that started after the lock was written.
    await writeFile(lock, String(process.ppid))
    const anHourAgo = new Date(Date.now() - 3_600_000)
    await utimes(lock, anHourAgo, anHourAgo)

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

  describe('with DATABASE_URL', () => {
    // The pool connects on its first query, so none of these needs a server.
    const URL = 'postgres://cms:secret@127.0.0.1:5432/cms'
    const poolOf = (env: Record<string, string>) => {
      const handle = openDatabase({ DATABASE_URL: URL, ...env })
      return { options: (handle.db as unknown as { $client: Pool }).$client.options, handle }
    }

    it('keeps pg’s pool of 10 connections, closed after 10 s idle, when nothing is set', async () => {
      const { options, handle } = poolOf({})
      expect(options).toMatchObject({ max: 10, idleTimeoutMillis: 10_000 })
      await handle.close()
    })

    it('sizes the pool and its idle timeout from CMS_DB_POOL_MAX and CMS_DB_POOL_IDLE_MS', async () => {
      const { options, handle } = poolOf({ CMS_DB_POOL_MAX: ' 2 ', CMS_DB_POOL_IDLE_MS: '0' })
      expect(options).toMatchObject({ max: 2, idleTimeoutMillis: 0 })
      await handle.close()
    })

    it.each([
      ['CMS_DB_POOL_MAX', '0', 'a whole number of connections, at least 1'],
      ['CMS_DB_POOL_MAX', '2.5', 'a whole number of connections, at least 1'],
      ['CMS_DB_POOL_MAX', 'ten', 'a whole number of connections, at least 1'],
      ['CMS_DB_POOL_IDLE_MS', '-1', 'a whole number of milliseconds, 0 or more'],
      ['CMS_DB_POOL_IDLE_MS', '10s', 'a whole number of milliseconds, 0 or more'],
    ])('refuses %s=%s', (name, value, expected) => {
      expect(() => openDatabase({ DATABASE_URL: URL, [name]: value })).toThrow(
        `${name} must be ${expected}, not "${value}".`,
      )
    })

    const SESSION =
      'postgresql://postgres.abcd:p%40ss@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?uselibpqcompat=true&sslmode=require'
    const TRANSACTION = SESSION.replace(':5432/', ':6543/')

    it('connects to Supabase’s pooler in transaction mode, given its session-mode address', async () => {
      const { options, handle } = poolOf({ DATABASE_URL: SESSION })
      expect(options.connectionString).toBe(TRANSACTION)
      await handle.close()
    })

    it('keeps session mode when CMS_DB_POOL_MODE asks for it', async () => {
      const { options, handle } = poolOf({ DATABASE_URL: SESSION, CMS_DB_POOL_MODE: 'session' })
      expect(options.connectionString).toBe(SESSION)
      await handle.close()
    })

    it('refuses a CMS_DB_POOL_MODE that isn’t a mode', () => {
      expect(() => openDatabase({ DATABASE_URL: URL, CMS_DB_POOL_MODE: 'pooled' })).toThrow(
        'CMS_DB_POOL_MODE must be "transaction" or "session", not "pooled".',
      )
    })
  })
})

describe('supabasePoolerUrl', () => {
  const session =
    'postgres://postgres.abcd:p%40ss@aws-0-eu-central-1.pooler.supabase.com:5432/postgres'
  const transaction = session.replace(':5432/', ':6543/')

  it('moves an address on Supabase’s pooler to the mode’s port, keeping the rest as it was', () => {
    expect(supabasePoolerUrl(session, 'transaction')).toBe(transaction)
    expect(supabasePoolerUrl(transaction, 'session')).toBe(session)
    expect(supabasePoolerUrl(`${session}?options=-c%20statement_timeout%3D5s`, 'transaction')).toBe(
      `${transaction}?options=-c%20statement_timeout%3D5s`,
    )
  })

  it('takes an address with no port as session mode’s, which is PostgreSQL’s', () => {
    expect(
      supabasePoolerUrl(
        'postgres://postgres.abcd@aws-1-us-east-1.pooler.supabase.com/postgres',
        'transaction',
      ),
    ).toBe('postgres://postgres.abcd@aws-1-us-east-1.pooler.supabase.com:6543/postgres')
  })

  it('returns an address already in the mode unchanged', () => {
    expect(supabasePoolerUrl(transaction, 'transaction')).toBe(transaction)
    expect(supabasePoolerUrl(session, 'session')).toBe(session)
  })

  it.each([
    ['another host', 'postgres://cms:secret@db.example.com:5432/cms'],
    [
      'Supabase’s direct connection',
      'postgres://postgres:secret@db.abcd.supabase.co:5432/postgres',
    ],
    [
      'a host that only contains the pooler’s name',
      'postgres://u@x.pooler.supabase.com.example.com:5432/db',
    ],
    [
      'another port on the pooler',
      'postgres://u@aws-0-eu-central-1.pooler.supabase.com:7777/postgres',
    ],
    ['something that isn’t a URL', 'host=/var/run/postgresql dbname=cms'],
  ])('leaves %s alone', (_, url) => {
    expect(supabasePoolerUrl(url, 'transaction')).toBe(url)
  })
})
