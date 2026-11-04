import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  maintainEmbeddedDatabase,
  openDatabase,
  scheduleMaintenance,
} from '../src/runtime/database'

let client: PGlite

beforeEach(() => {
  client = new PGlite()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await client.close()
})

/** Table statistics reach the views a moment after the writes; this makes it now. */
async function flushStatistics(): Promise<void> {
  await client.query('SELECT pg_stat_force_next_flush()')
  await client.query('SELECT 1')
}

async function statsOf(table: string) {
  const { rows } = await client.query<{ analyzed: boolean; dead: number }>(
    `SELECT last_analyze IS NOT NULL AS analyzed, n_dead_tup::int AS dead
       FROM pg_stat_user_tables WHERE relname = $1`,
    [table],
  )
  return rows[0]
}

it('analyzes and vacuums each table that changed enough, as autovacuum would', async () => {
  await client.exec(`
    CREATE TABLE posts (id int PRIMARY KEY, title text);
    INSERT INTO posts SELECT g, 'Post ' || g FROM generate_series(1, 3000) g;
    UPDATE posts SET title = title || '!' WHERE id <= 700;
    CREATE TABLE quiet (id int PRIMARY KEY);
  `)
  await flushStatistics()

  expect(await maintainEmbeddedDatabase(client)).toEqual({
    analyzed: ['public.posts'],
    vacuumed: ['public.posts'],
  })
  expect(await statsOf('posts')).toEqual({ analyzed: true, dead: 0 })
  // Empty and never written: nothing to learn.
  expect(await statsOf('quiet')).toEqual({ analyzed: false, dead: 0 })
})

it('leaves a table alone until enough of it has changed', async () => {
  await client.exec(`
    CREATE TABLE posts (id int PRIMARY KEY, title text);
    INSERT INTO posts SELECT g, 'Post ' || g FROM generate_series(1, 3000) g;
  `)
  await flushStatistics()
  await maintainEmbeddedDatabase(client)

  // 40 changes: below autovacuum's 50 plus 10% of the rows for statistics, 20% for a vacuum.
  await client.exec(`UPDATE posts SET title = title || '!' WHERE id <= 40`)
  await flushStatistics()
  expect(await maintainEmbeddedDatabase(client)).toEqual({ analyzed: [], vacuumed: [] })

  await client.exec(`UPDATE posts SET title = title || '?' WHERE id <= 400`)
  await flushStatistics()
  expect((await maintainEmbeddedDatabase(client)).analyzed).toEqual(['public.posts'])
})

it('checks on a timer, says what failed, and stops when asked', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  let checks = 0
  const failing = {
    query: async () => {
      checks++
      throw new Error('the database is closed')
    },
    exec: async () => [],
  } as unknown as PGlite
  const stop = scheduleMaintenance(failing, { firstMs: 5, everyMs: 10 })
  await vi.waitFor(() => expect(checks).toBeGreaterThanOrEqual(2))
  stop()
  const stoppedAt = checks
  await new Promise((resolve) => setTimeout(resolve, 40))
  expect(checks).toBe(stoppedAt)
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('the database is closed'))
})

it('opens an embedded database that maintains itself, and closes it with its timer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cms-db-maintain-'))
  try {
    const handle = openDatabase({ CMS_DATA_DIR: join(root, 'pglite') }, { maintain: true })
    await handle.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
