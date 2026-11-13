import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import type { Kernel } from '../src/kernel'
import { bootKernel, memoryLogger, plugin, signIn } from './helpers'

/** Runs one of core's own jobs now, rather than at its daily time. */
async function run(kernel: Kernel, name: 'core.cleanup' | 'core.empty_trash') {
  await kernel.jobs.enqueue(name, {})
  return kernel.jobs.runDue()
}

const count = async (kernel: Kernel, table: string, where = 'true') => {
  const result = (await kernel.db.execute(
    sql.raw(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`),
  )) as unknown as { rows: { n: number }[] }
  return result.rows[0]!.n
}

describe('core’s daily jobs', () => {
  it('are in every site’s queue, a day apart', async () => {
    const kernel = await bootKernel({ plugins: [] })
    await kernel.jobs.runDue()
    const { jobs } = await kernel.jobs.list({ status: 'pending' })
    expect(jobs.map((job) => [job.name, job.everySeconds, job.defined]).sort()).toEqual([
      ['core.cleanup', 86_400, true],
      ['core.empty_trash', 86_400, true],
    ])
    expect(jobs[0]!.label).not.toBe(jobs[0]!.name)
  })

  it('clear out sessions and links that ran out, old failed and held sign-ins and old job logs', async () => {
    const kernel = await bootKernel({ plugins: [] })
    const { user } = await signIn(kernel)
    await kernel.auth.createSession(user.id)
    await kernel.db.execute(sql`
      UPDATE cms_sessions SET expires_at = now() - interval '1 minute'
       WHERE token_hash = (SELECT min(token_hash) FROM cms_sessions)
    `)
    await kernel.db.execute(sql`
      INSERT INTO cms_user_tokens (user_id, purpose, token_hash, expires_at) VALUES
        (${user.id}, 'password', 'ran-out', now() - interval '1 hour'),
        (${user.id}, 'password', 'still-good', now() + interval '1 hour')
    `)
    await kernel.db.execute(sql`
      INSERT INTO cms_login_failures (email, failed_at) VALUES
        ('old@cms.test', now() - interval '2 days'), ('recent@cms.test', now() - interval '5 minutes')
    `)
    await kernel.db.execute(sql`
      INSERT INTO cms_jobs (name, status, finished_at) VALUES
        ('shop.gone', 'done', now() - interval '31 days'),
        ('shop.gone', 'failed', now() - interval '45 days'),
        ('shop.gone', 'done', now() - interval '29 days')
    `)

    await kernel.db.execute(sql`
      INSERT INTO cms_sign_ins (token_hash, user_id, next, via, expires_at, created_at) VALUES
        ('old', ${user.id}, '/admin', 'password', now() - interval '2 days', now() - interval '2 days'),
        ('counted', ${user.id}, '/admin', 'password', now() - interval '1 minute', now() - interval '11 minutes')
    `)

    expect((await run(kernel, 'core.cleanup')).ran).toBe(1)
    expect(await count(kernel, 'cms_sessions')).toBe(1)
    // A held sign-in that ran out stays for the day: its wrong codes still count.
    expect(await count(kernel, 'cms_sign_ins', `token_hash = 'counted'`)).toBe(1)
    expect(await count(kernel, 'cms_sign_ins')).toBe(1)
    expect(await count(kernel, 'cms_user_tokens', `token_hash = 'still-good'`)).toBe(1)
    expect(await count(kernel, 'cms_user_tokens')).toBe(1)
    expect(await count(kernel, 'cms_login_failures', `email = 'recent@cms.test'`)).toBe(1)
    expect(await count(kernel, 'cms_login_failures')).toBe(1)
    expect(await count(kernel, 'cms_jobs', `name = 'shop.gone'`)).toBe(1)
  })

  it('delete for good what has been in the Trash 30 days, and tell plugins as any delete does', async () => {
    const deleted: string[] = []
    const listener = plugin('listener', {
      setup: (cms) =>
        cms.hooks.addAction('content.deleted', ({ entry }) => void deleted.push(entry.title)),
    })
    const kernel = await bootKernel({ plugins: [listener] })
    const titles = ['Long gone', 'Just binned', 'Still a draft']
    const [old, recent, draft] = await Promise.all(
      titles.map((title) => kernel.content.create('core.post', { title })),
    )
    await kernel.content.trash(old!.id)
    await kernel.content.trash(recent!.id)
    await kernel.db.execute(
      sql`UPDATE cms_entries SET trashed_at = now() - interval '31 days' WHERE id = ${old!.id}`,
    )
    await kernel.db.execute(
      sql`UPDATE cms_entries SET trashed_at = now() - interval '29 days' WHERE id = ${recent!.id}`,
    )

    expect((await run(kernel, 'core.empty_trash')).ran).toBe(1)
    expect(deleted).toEqual(['Long gone'])
    expect(await kernel.content.get(old!.id)).toBeNull()
    expect((await kernel.content.get(recent!.id))?.status).toBe('trash')
    expect((await kernel.content.get(draft!.id))?.status).toBe('draft')
  })

  it('empty a large Trash a hundred entries at a time, one run after another', async () => {
    const logger = memoryLogger()
    const kernel = await bootKernel({ plugins: [], logger })
    await kernel.db.execute(sql`
      INSERT INTO cms_entries (type, status, title, slug, trashed_from, trashed_at)
      SELECT 'core.post', 'trash', 'Old ' || n, 'old-' || n, 'draft', now() - interval '40 days'
        FROM generate_series(1, 130) AS n
    `)

    // The first run queues the second, which the same look at the queue runs.
    expect((await run(kernel, 'core.empty_trash')).ran).toBe(2)
    expect(await count(kernel, 'cms_entries')).toBe(0)
    expect(logger.entries.filter((entry) => entry.level === 'error')).toEqual([])
  })
})
