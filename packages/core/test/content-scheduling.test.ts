import { ContentError, type Entry, type EntryStatus } from '@otwdesign/sdk'
import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { coreMigrations } from '../src/core-migrations'
import { DatabaseContext } from '../src/database'
import type { Kernel } from '../src/kernel'
import { runMigrations } from '../src/migrations'
import { bootKernel, createDb, memoryLogger, PASSWORD, plugin } from './helpers'

const HOUR = 3_600_000
const ahead = (ms: number) => new Date(Date.now() + ms)

interface Moved {
  title: string
  from: EntryStatus | null
  to: EntryStatus
}

/** A site whose plugin records each status change and each save. */
async function site() {
  const moved: Moved[] = []
  const saved: string[] = []
  const listener = plugin('listener', {
    setup(cms) {
      cms.hooks.addAction('content.status', ({ entry, from, to }) => {
        moved.push({ title: entry.title, from, to })
      })
      cms.hooks.addAction('content.saved', ({ entry }) => void saved.push(entry.status))
    },
  })
  const woken: Date[] = []
  const kernel = await bootKernel({
    plugins: [listener],
    onJobQueued: (dueAt) => woken.push(dueAt),
  })
  return { kernel, content: kernel.content, moved, saved, woken }
}

/** The jobs that publish this entry, soonest first, with their state. */
async function publishJobs(kernel: Kernel, entry: Entry) {
  const { jobs } = await kernel.jobs.list({ search: 'core.publish_entry', perPage: 100 })
  return jobs
    .filter((job) => job.args.id === entry.id)
    .sort((a, b) => a.runAt.getTime() - b.runAt.getTime())
    .map((job) => ({ status: job.status, runAt: job.runAt }))
}

/** As if the entry's date had come: its date and its job's time move into the past. */
async function reach(kernel: Kernel, entry: Entry) {
  await kernel.db.execute(
    sql`UPDATE cms_entries SET published_at = now() - interval '1 second' WHERE id = ${entry.id}`,
  )
  await kernel.db.execute(sql`
    UPDATE cms_jobs SET run_at = now() - interval '1 second'
     WHERE name = 'core.publish_entry' AND status = 'pending' AND args ->> 'id' = ${entry.id}
  `)
}

describe('scheduling', () => {
  it('saves a published entry dated a minute or more ahead as scheduled, with its slug', async () => {
    const { content, moved } = await site()
    const at = ahead(HOUR)
    const post = await content.create('core.post', {
      title: 'Opening day',
      status: 'published',
      publishedAt: at,
    })
    expect(post).toMatchObject({ status: 'scheduled', publishedAt: at, slug: 'opening-day' })
    expect(moved).toEqual([{ title: 'Opening day', from: null, to: 'scheduled' }])

    // Under a minute ahead is now, as in wp_insert_post().
    const soon = await content.create('core.post', {
      status: 'published',
      publishedAt: ahead(30_000),
    })
    expect(soon.status).toBe('published')
    // Private entries aren't scheduled.
    const secret = await content.create('core.post', { status: 'private', publishedAt: at })
    expect(secret.status).toBe('private')
  })

  it('publishes an entry saved as scheduled whose date has come, and refuses one without a date', async () => {
    const { content } = await site()
    const past = new Date('2020-01-02T03:04:05Z')
    const post = await content.create('core.post', { status: 'scheduled', publishedAt: past })
    expect(post).toMatchObject({ status: 'published', publishedAt: past })
    const error = await content.create('core.post', { status: 'scheduled' }).catch((e) => e)
    expect(error).toBeInstanceOf(ContentError)
    expect((error as ContentError).message).toBe(
      'A scheduled entry needs the date it is published on',
    )
  })

  it('owns its slug before its day, and isn’t found on the site by it', async () => {
    const { content } = await site()
    const scheduled = await content.create('core.post', {
      title: 'News',
      status: 'published',
      publishedAt: ahead(HOUR),
    })
    const live = await content.create('core.post', { title: 'News', status: 'published' })
    expect([scheduled.slug, live.slug]).toEqual(['news', 'news-2'])
    expect(await content.getBySlug('core.post', 'news')).toBeNull()
    expect((await content.getBySlug('core.post', 'news-2'))?.id).toBe(live.id)
  })

  it('queues the job that publishes it, for its date, with the save', async () => {
    const { kernel, content, woken } = await site()
    const at = ahead(HOUR)
    const post = await content.create('core.post', { status: 'published', publishedAt: at })
    expect(await publishJobs(kernel, post)).toEqual([{ status: 'pending', runAt: at }])
    expect(woken).toEqual([at])

    // Nothing is queued for a save that fails.
    await expect(
      kernel.transaction(async () => {
        await content.create('core.post', { title: 'Lost', status: 'published', publishedAt: at })
        throw new Error('The save went wrong')
      }),
    ).rejects.toThrow('went wrong')
    expect((await kernel.jobs.list({ search: 'core.publish_entry' })).total).toBe(1)
  })

  it('asks the queue nothing for a save that neither starts nor ends as scheduled', async () => {
    const { kernel, content } = await site()
    const post = await content.create('core.post', { title: 'Plain', status: 'published' })
    await content.update(post.id, { title: 'Plainer' })
    await content.update(post.id, { status: 'draft' })
    await content.trash(post.id)
    await content.delete(post.id)
    expect((await kernel.jobs.list({ search: 'core.publish_entry' })).total).toBe(0)
  })

  it('moves the job with the date, and leaves it alone when the date stays', async () => {
    const { kernel, content } = await site()
    const first = ahead(HOUR)
    const second = ahead(2 * HOUR)
    const post = await content.create('core.post', { status: 'published', publishedAt: first })
    await content.update(post.id, { title: 'A better title' })
    expect(await publishJobs(kernel, post)).toEqual([{ status: 'pending', runAt: first }])

    const moved = await content.update(post.id, { publishedAt: second })
    expect(moved).toMatchObject({ status: 'scheduled', publishedAt: second })
    expect(await publishJobs(kernel, post)).toEqual([
      { status: 'cancelled', runAt: first },
      { status: 'pending', runAt: second },
    ])
  })

  it.each(['draft', 'pending', 'private'] as const)(
    'cancels the job when the entry becomes %s',
    async (status) => {
      const { kernel, content } = await site()
      const at = ahead(HOUR)
      const post = await content.create('core.post', { status: 'published', publishedAt: at })
      expect((await content.update(post.id, { status })).status).toBe(status)
      expect(await publishJobs(kernel, post)).toEqual([{ status: 'cancelled', runAt: at }])
    },
  )

  it('cancels the job when the entry is trashed or deleted, and restores it as a draft', async () => {
    const { kernel, content } = await site()
    const at = ahead(HOUR)
    const trashed = await content.create('core.post', { status: 'published', publishedAt: at })
    const binned = await content.trash(trashed.id)
    expect(binned).toMatchObject({ status: 'trash', trashedFrom: 'scheduled' })
    expect(await publishJobs(kernel, trashed)).toEqual([{ status: 'cancelled', runAt: at }])
    expect((await content.restore(trashed.id)).status).toBe('draft')
    expect(await publishJobs(kernel, trashed)).toHaveLength(1)

    const deleted = await content.create('core.post', { status: 'published', publishedAt: at })
    await content.delete(deleted.id)
    expect(await publishJobs(kernel, deleted)).toEqual([{ status: 'cancelled', runAt: at }])
  })

  it('publishing it now cancels the job', async () => {
    const { kernel, content, moved } = await site()
    const at = ahead(HOUR)
    const post = await content.create('core.post', {
      title: 'Early',
      status: 'published',
      publishedAt: at,
    })
    const now = new Date(Date.now() - 1000)
    const early = await content.update(post.id, { status: 'published', publishedAt: now })
    expect(early).toMatchObject({ status: 'published', publishedAt: now })
    expect(await publishJobs(kernel, post)).toEqual([{ status: 'cancelled', runAt: at }])
    expect(moved.map((move) => move.to)).toEqual(['scheduled', 'published'])
  })
})

describe('the job that publishes a scheduled entry', () => {
  it('publishes it when its date comes, as any publish: with its date, its slug and the hooks', async () => {
    const { kernel, content, moved, saved } = await site()
    const post = await content.create('core.post', {
      title: 'Opening day',
      status: 'published',
      publishedAt: ahead(HOUR),
    })
    expect((await kernel.jobs.runDue()).ran).toBe(0)
    await reach(kernel, post)
    const due = (await content.get(post.id))!.publishedAt

    expect((await kernel.jobs.runDue()).ran).toBe(1)
    const published = (await content.get(post.id))!
    expect(published).toMatchObject({ status: 'published', slug: 'opening-day', publishedAt: due })
    expect(moved).toEqual([
      { title: 'Opening day', from: null, to: 'scheduled' },
      { title: 'Opening day', from: 'scheduled', to: 'published' },
    ])
    expect(saved).toEqual(['scheduled', 'published'])
    expect((await content.getBySlug('core.post', 'opening-day'))?.id).toBe(post.id)
    expect((await publishJobs(kernel, post)).map((job) => job.status)).toEqual(['done'])
    // Published without a new revision: nobody wrote anything.
    expect((await content.revisions(post.id)).total).toBe(1)
  })

  it('run before its time, leaves the entry scheduled and waits for the date again', async () => {
    const { kernel, content } = await site()
    const at = ahead(HOUR)
    const post = await content.create('core.post', { status: 'published', publishedAt: at })
    // Someone pressed Run in Tools › Scheduled Actions.
    await kernel.db.execute(
      sql`UPDATE cms_jobs SET run_at = now() WHERE name = 'core.publish_entry'`,
    )

    expect((await kernel.jobs.runDue()).ran).toBe(1)
    expect((await content.get(post.id))!.status).toBe('scheduled')
    expect((await publishJobs(kernel, post)).filter((job) => job.status === 'pending')).toEqual([
      { status: 'pending', runAt: at },
    ])
  })

  it('does nothing for an entry that is no longer scheduled, or is gone', async () => {
    const { kernel, content, moved } = await site()
    const at = ahead(HOUR)
    const draft = await content.create('core.post', { status: 'published', publishedAt: at })
    const gone = await content.create('core.post', { status: 'published', publishedAt: at })
    // As if the jobs had been taken to run just as the entries changed.
    await kernel.db.execute(sql`UPDATE cms_entries SET status = 'draft' WHERE id = ${draft.id}`)
    await kernel.db.execute(sql`DELETE FROM cms_entries WHERE id = ${gone.id}`)
    await kernel.db.execute(
      sql`UPDATE cms_jobs SET run_at = now() WHERE name = 'core.publish_entry'`,
    )
    moved.length = 0

    expect((await kernel.jobs.runDue()).ran).toBe(2)
    expect((await content.get(draft.id))!.status).toBe('draft')
    expect(moved).toEqual([])
    const { jobs } = await kernel.jobs.list({ search: 'core.publish_entry' })
    expect(jobs.map((job) => job.status)).toEqual(['done', 'done'])
  })

  it('publishes a page under a scheduled parent only when its own date comes', async () => {
    const { kernel, content } = await site()
    const parent = await content.create('core.page', {
      title: 'Menu',
      status: 'published',
      publishedAt: ahead(HOUR),
    })
    const child = await content.create('core.page', {
      title: 'Lunch',
      status: 'published',
      parentId: parent.id,
    })
    // The child is published, but its address runs through a page that isn't open yet.
    expect((await content.permalinks([child])).get(child.id)).toBeNull()
    await reach(kernel, parent)
    await kernel.jobs.runDue()
    expect((await content.permalinks([child])).get(child.id)).toBe('/menu/lunch')
  })
})

describe('who may change a scheduled entry', () => {
  it('needs what a published entry needs, as WordPress asks of `future`', async () => {
    const { kernel, content } = await site()
    const writer = await kernel.auth.createUser({
      email: 'contributor@cms.test',
      role: 'contributor',
      password: PASSWORD,
    })
    const author = await kernel.auth.createUser({
      email: 'author@cms.test',
      role: 'author',
      password: PASSWORD,
    })
    const type = content.getType('core.post')!
    const scheduled = (authorId: string) =>
      content.create('core.post', { status: 'published', publishedAt: ahead(HOUR), authorId })
    const can = (user: typeof writer, capability: string, entry: Entry) =>
      (kernel.can as (...args: unknown[]) => boolean)(user, capability, entry)

    // A contributor may edit their drafts, not what is published or about to be.
    const theirs = await scheduled(writer.id)
    expect(can(writer, type.capabilities.editEntry, theirs)).toBe(false)
    expect(can(writer, type.capabilities.deleteEntry, theirs)).toBe(false)
    // An author may, their own; and reads it, though the site doesn't show it yet.
    const own = await scheduled(author.id)
    expect(can(author, type.capabilities.editEntry, own)).toBe(true)
    expect(can(author, type.capabilities.readEntry, own)).toBe(true)
    expect(can(author, type.capabilities.editEntry, theirs)).toBe(false)
    expect(can(author, type.capabilities.readEntry, theirs)).toBe(false)
  })
})

describe('a site from before entries could be scheduled', () => {
  it('gains the status with its database update, and keeps what it had', async () => {
    const db = createDb()
    const core = (migrations: typeof coreMigrations) =>
      runMigrations(new DatabaseContext(db), [plugin('core', { migrations })], memoryLogger())
    await core(coreMigrations.filter((migration) => migration.id !== '0013_scheduled_entries'))
    await db.execute(sql`
      INSERT INTO cms_entries (type, status, slug, title, published_at, trashed_from, trashed_at) VALUES
        ('core.post', 'published', 'news', 'News', now(), NULL, NULL),
        ('core.post', 'draft', '', 'News', NULL, NULL, NULL),
        ('core.post', 'trash', 'old', 'Old', now(), 'published', now())
    `)
    const scheduledRow = (slug: string) => sql`
      INSERT INTO cms_entries (type, status, slug, published_at)
      VALUES ('core.post', 'scheduled', ${slug}, now() + interval '1 day')
    `
    await expect(db.execute(scheduledRow('later'))).rejects.toThrow()

    expect(await core(coreMigrations)).toEqual(['core/0013_scheduled_entries'])
    const kernel = await bootKernel({ plugins: [], db })
    expect(await kernel.content.count('core.post')).toMatchObject({
      published: 1,
      draft: 1,
      trash: 1,
      scheduled: 0,
    })
    // A scheduled entry owns its slug among the published ones, in the database too.
    const scheduled = await kernel.content.create('core.post', {
      title: 'News',
      status: 'published',
      publishedAt: ahead(HOUR),
    })
    expect(scheduled).toMatchObject({ status: 'scheduled', slug: 'news-2' })
    await expect(db.execute(scheduledRow('news-2'))).rejects.toThrow()
    await expect(db.execute(scheduledRow(''))).rejects.toThrow()
    await expect(
      db.execute(sql`INSERT INTO cms_entries (type, status) VALUES ('core.post', 'future')`),
    ).rejects.toThrow()
    // The trash remembers a scheduled entry's status.
    expect((await kernel.content.trash(scheduled.id)).trashedFrom).toBe('scheduled')
  })
})
