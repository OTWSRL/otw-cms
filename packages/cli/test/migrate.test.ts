import { execFile } from 'node:child_process'
import { access, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { createMemoryLogger } from '@otwdesign/core'
import type { Migration } from '@otwdesign/sdk'
import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate, pgDumpTarget } from '../src/migrate.ts'

const run = promisify(execFile)

const shop = (migrations: Migration[]) => ({ id: 'shop', version: '1.0.0', migrations })
const products: Migration = {
  id: '0001_products',
  up: (db) => db.execute(sql`CREATE TABLE shop_products (id serial PRIMARY KEY)`),
}
const coupons: Migration = {
  id: '0002_coupons',
  up: (db) => db.execute(sql`CREATE TABLE shop_coupons (id serial PRIMARY KEY)`),
}

describe('cms migrate', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cms-migrate-'))
  })
  afterEach(() => rm(root, { recursive: true, force: true }))

  const options = (plugins: ReturnType<typeof shop>[], extra = {}) => ({
    root,
    env: { CMS_DATA_DIR: join(root, '.data', 'pglite') },
    site: { plugins },
    logger: createMemoryLogger(),
    now: () => new Date('2026-11-01T10:00:00.000Z'),
    ...extra,
  })

  it('migrates a new site without a backup, since there is nothing to lose', async () => {
    const result = await migrate(options([shop([products])]))
    expect(result).toEqual({
      applied: [
        'core/0001_core_tables',
        'core/0002_entries',
        'core/0003_terms',
        'core/0004_entry_meta',
        'core/0005_revisions',
        'core/0006_media',
        'core/0007_featured_images',
        'core/0008_accounts',
        'core/0009_user_meta',
        'core/0010_entry_search',
        'core/0011_entry_counts',
        'core/0012_jobs',
        'core/0013_scheduled_entries',
        'core/0014_webhooks',
        'core/0015_cache',
        'shop/0001_products',
      ],
      backup: null,
    })
  })

  it('backs up the embedded database before the next release’s migrations', async () => {
    await migrate(options([shop([products])]))
    expect(await migrate(options([shop([products, coupons])], { dryRun: true }))).toEqual({
      pending: ['shop/0002_coupons'],
    })
    const result = await migrate(options([shop([products, coupons])]))
    const backup = join(root, '.data', 'backups', 'pglite-2026-11-01T10-00-00-000Z')
    expect(result).toEqual({ applied: ['shop/0002_coupons'], backup })
    expect((await readdir(backup)).length).toBeGreaterThan(0)
    expect(await migrate(options([shop([products, coupons])], { dryRun: true }))).toEqual({
      pending: [],
    })
  })

  it('wants a backup of Postgres, or to be told the host takes them', async () => {
    const postgres = options([shop([products])], {
      env: { DATABASE_URL: 'postgres://cms:secret@db.invalid:5432/cms' },
      hasPgDump: async () => false,
    })
    await expect(migrate(postgres)).rejects.toThrow('run `cms migrate --no-backup`')
  })
})

describe('pgDumpTarget', () => {
  it('passes the password through the environment, not the command line', () => {
    expect(pgDumpTarget('postgres://cms:s%40cret@db.example.com:5432/cms')).toEqual({
      url: 'postgres://cms@db.example.com:5432/cms',
      password: 's@cret',
    })
    expect(pgDumpTarget('postgres://cms@db.example.com/cms')).toEqual({
      url: 'postgres://cms@db.example.com/cms',
      password: '',
    })
  })

  it('drops node-postgres’s uselibpqcompat, which pg_dump refuses, keeping the other parameters', () => {
    expect(
      pgDumpTarget('postgres://cms@db.example.com/cms?uselibpqcompat=true&sslmode=require').url,
    ).toBe('postgres://cms@db.example.com/cms?sslmode=require')
    expect(
      pgDumpTarget(
        'postgres://cms@db.example.com/cms?options=-c%20search_path%3Dcms&uselibpqcompat=true',
      ).url,
    ).toBe('postgres://cms@db.example.com/cms?options=-c%20search_path%3Dcms')
    expect(pgDumpTarget('postgres://cms@db.example.com/cms?uselibpqcompat=true').url).toBe(
      'postgres://cms@db.example.com/cms',
    )
  })

  it('dumps Supabase’s pooler in session mode, as a dump runs in one session', () => {
    expect(
      pgDumpTarget(
        'postgres://postgres.abcd:secret@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?uselibpqcompat=true&sslmode=require',
      ),
    ).toEqual({
      url: 'postgres://postgres.abcd@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require',
      password: 'secret',
    })
  })
})

/** The real binary, as a site runs it: tsx loads the CLI, the CMS and the site's plugins. */
describe('the cms binary', () => {
  const bin = resolve(import.meta.dirname, '../bin/cms.js')
  const site = resolve(import.meta.dirname, '../../../apps/web')
  let data: string
  beforeEach(async () => {
    data = await mkdtemp(join(tmpdir(), 'cms-bin-'))
  })
  afterEach(() => rm(data, { recursive: true, force: true }))

  const cms = (...args: string[]) =>
    run(process.execPath, [bin, ...args, '--root', site], {
      env: { ...process.env, CMS_DATA_DIR: join(data, 'pglite'), DATABASE_URL: '' },
    })

  it('lists, applies, then finds nothing left to migrate', { timeout: 60_000 }, async () => {
    const dry = await cms('migrate', '--dry-run')
    expect(dry.stdout).toContain('pending migrations:')
    expect(dry.stdout).toContain('core/0001_core_tables')
    // The e2e site's Library fixture brings a migration of its own: plugins' run with core's.
    expect(dry.stdout).toMatch(/library\/\d{4}_/)
    // A dry run never creates the database.
    await expect(access(join(data, 'pglite'))).rejects.toThrow('ENOENT')

    const applied = await cms('migrate')
    expect(applied.stdout).toMatch(/applied \d+ migration\(s\)/)
    const again = await cms('migrate')
    expect(again.stdout).toContain('backed up the database')
    expect(again.stdout).toContain('the database is up to date')
  })
})
