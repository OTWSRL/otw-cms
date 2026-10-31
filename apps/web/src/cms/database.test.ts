import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from './database'

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
})
