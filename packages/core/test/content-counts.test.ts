import type { Database } from '@otwdesign/sdk'
import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { coreMigrations } from '../src/core-migrations'
import { DatabaseContext } from '../src/database'
import { runMigrations } from '../src/migrations'
import { bootKernel, createDb, memoryLogger, PASSWORD, plugin } from './helpers'

const rows = async (db: Database, query: ReturnType<typeof sql>) =>
  ((await db.execute(query)) as unknown as { rows: object[] }).rows

/**
 * The summary tables against a scan of every entry, which is what they stand in for. Rows the
 * summary keeps at zero aren't counted.
 */
async function expectSummaryToMatchEntries(db: Database): Promise<void> {
  const byKey = <T extends object>(list: T[]) => list.map((row) => JSON.stringify(row)).sort()
  expect(
    byKey(
      await rows(
        db,
        sql`SELECT type, status, author_id, entries FROM cms_entry_counts WHERE entries > 0`,
      ),
    ),
  ).toEqual(
    byKey(
      await rows(
        db,
        sql`SELECT type, status, author_id, count(*)::int AS entries FROM cms_entries
              GROUP BY type, status, author_id`,
      ),
    ),
  )
  expect(
    byKey(
      await rows(
        db,
        sql`SELECT type, status, month::text, entries FROM cms_entry_months WHERE entries > 0`,
      ),
    ),
  ).toEqual(
    byKey(
      await rows(
        db,
        sql`SELECT type, status,
                   (date_trunc('month', coalesce(published_at, created_at) AT TIME ZONE 'UTC'))::date::text AS month,
                   count(*)::int AS entries
              FROM cms_entries GROUP BY 1, 2, 3`,
      ),
    ),
  )
}

describe('entry counts and months', () => {
  it('stay those of the entries through every change, without scanning them', async () => {
    const db = createDb()
    const kernel = await bootKernel({ plugins: [], db })
    const [ada, bo] = await Promise.all(
      ['ada', 'bo'].map((name) =>
        kernel.auth.createUser({
          email: `${name}@example.com`,
          name,
          role: 'author',
          password: PASSWORD,
        }),
      ),
    )
    const draft = await kernel.content.create('core.post', { title: 'Draft', authorId: ada!.id })
    const march = await kernel.content.create('core.post', {
      title: 'March',
      status: 'published',
      authorId: ada!.id,
      publishedAt: new Date('2026-03-10T12:00:00Z'),
    })
    // 23:30 UTC on New Year's Eve: December, in the UTC the filter uses.
    const december = await kernel.content.create('core.post', {
      title: 'December',
      status: 'published',
      authorId: bo!.id,
      publishedAt: new Date('2025-12-31T23:30:00Z'),
    })
    await kernel.content.create('core.page', { title: 'About', status: 'published' })
    await expectSummaryToMatchEntries(db)
    expect(await kernel.content.count('core.post')).toEqual({
      draft: 1,
      pending: 0,
      scheduled: 0,
      published: 2,
      private: 0,
      trash: 0,
    })
    expect(await kernel.content.count('core.post', { authorId: ada!.id })).toMatchObject({
      draft: 1,
      published: 1,
    })
    expect(await kernel.content.months('core.post', { status: ['published'] })).toEqual([
      { year: 2026, month: 3 },
      { year: 2025, month: 12 },
    ])

    await kernel.content.update(draft.id, { status: 'published' })
    await kernel.content.update(march.id, { authorId: bo!.id })
    await kernel.content.update(december.id, { publishedAt: new Date('2026-01-15T08:00:00Z') })
    await kernel.content.update(december.id, { title: 'Still January' })
    await expectSummaryToMatchEntries(db)
    expect(await kernel.content.months('core.post', { status: ['published'] })).toEqual(
      expect.arrayContaining([{ year: 2026, month: 1 }]),
    )
    expect(await kernel.content.months('core.post', { status: ['published'] })).not.toContainEqual({
      year: 2025,
      month: 12,
    })

    // A scheduled entry counts as scheduled, in its month, and not among the published ones.
    const year = new Date().getUTCFullYear() + 1
    const scheduled = await kernel.content.create('core.post', {
      title: 'Next year',
      status: 'published',
      publishedAt: new Date(Date.UTC(year, 6, 1)),
    })
    await expectSummaryToMatchEntries(db)
    expect(await kernel.content.count('core.post')).toMatchObject({ scheduled: 1, published: 3 })
    expect(await kernel.content.months('core.post', { status: ['scheduled'] })).toEqual([
      { year, month: 7 },
    ])
    expect(await kernel.content.months('core.post', { status: ['published'] })).not.toContainEqual({
      year,
      month: 7,
    })
    await kernel.content.delete(scheduled.id)

    await kernel.content.trash(march.id)
    await expectSummaryToMatchEntries(db)
    expect((await kernel.content.count('core.post')).trash).toBe(1)
    await kernel.content.restore(march.id)
    await kernel.content.delete(draft.id)
    await expectSummaryToMatchEntries(db)

    // A deleted user's entries lose their author, through the foreign key.
    await db.execute(sql`DELETE FROM cms_users WHERE id = ${bo!.id}`)
    await expectSummaryToMatchEntries(db)
    expect(await kernel.content.count('core.post', { authorId: bo!.id })).toMatchObject({
      published: 0,
      draft: 0,
    })
  })

  it('count the entries a site had before the summary existed', async () => {
    const db = createDb()
    const core = (migrations: typeof coreMigrations) =>
      runMigrations(new DatabaseContext(db), [plugin('core', { migrations })], memoryLogger())
    await core(coreMigrations.filter((migration) => migration.id !== '0011_entry_counts'))
    await db.execute(sql`
      INSERT INTO cms_entries (type, status, slug, published_at) VALUES
        ('core.post', 'published', 'one', '2026-02-03T10:00:00Z'),
        ('core.post', 'published', 'two', '2026-02-20T10:00:00Z'),
        ('core.post', 'draft', '', NULL),
        ('core.page', 'published', 'about', '2025-07-01T00:00:00Z')
    `)
    expect(await core(coreMigrations)).toEqual(['core/0011_entry_counts'])
    await expectSummaryToMatchEntries(db)
  })
})
