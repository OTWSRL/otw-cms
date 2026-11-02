import { ContentError, defineAdmin, type Entry, type PluginContext } from '@otw/sdk'
import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import type { Kernel } from '../src/kernel'
import { bootKernel, memoryLogger, PASSWORD, plugin } from './helpers'

declare module '@otw/sdk' {
  interface ContentTypes {
    'library.book': true
  }
}

const library = plugin('library', {
  setup: (cms) => cms.content.type('book', { labels: { singular: 'Book', plural: 'Books' } }),
})

async function site(options: { plugins?: Parameters<typeof bootKernel>[0]['plugins'] } = {}) {
  const kernel = await bootKernel({ plugins: options.plugins ?? [library] })
  return { kernel, content: kernel.content }
}

let users = 0
async function author(kernel: Kernel, role = 'author') {
  return kernel.auth.createUser({ email: `writer-${++users}@cms.test`, role, password: PASSWORD })
}

/** Rejects with a ContentError of this code and message. */
async function refused(promise: Promise<unknown>, code: string, message: string | RegExp) {
  const error = await promise.then(
    () => expect.fail('expected a ContentError'),
    (error: unknown) => error,
  )
  expect(error).toBeInstanceOf(ContentError)
  expect((error as ContentError).code).toBe(code)
  expect((error as ContentError).message).toMatch(message)
}

describe('content types', () => {
  it("are core's Posts and Pages, then each plugin's, named after the plugin", async () => {
    const { content } = await site()
    expect(content.types().map((type) => type.name)).toEqual([
      'core.post',
      'core.page',
      'library.book',
    ])
    expect(content.getType('core.page')).toMatchObject({
      labels: { singular: 'Page', plural: 'Pages' },
      public: true,
      hierarchical: true,
      supports: ['title', 'body', 'author', 'position'],
    })
    expect(content.getType('library.book')).toMatchObject({
      pluginId: 'library',
      public: false,
      hierarchical: false,
      supports: ['title', 'body'],
    })
  })

  it('are registered in setup(), not the admin entry', async () => {
    const shelf = plugin('shelf')
    await expect(
      bootKernel({
        plugins: [shelf],
        admin: [
          defineAdmin(shelf, (cms) =>
            cms.content.type('book', { labels: { singular: 'Book', plural: 'Books' } }),
          ),
        ],
      }),
    ).rejects.toThrow('Register content type "shelf.book" in setup()')
  })

  it('keep their entries when their plugin is off; only administrators may change them then', async () => {
    const { kernel, content } = await site()
    const book = await content.create('library.book', { title: 'Dune', status: 'published' })
    const off = await bootKernel({ plugins: [library], active: [], db: kernel.db })
    expect(await off.content.get(book.id)).toEqual(book)
    await refused(
      off.content.update(book.id, { title: 'Dune II' }),
      'unknown_type',
      /library\.book/,
    )
    await refused(off.content.create('library.book'), 'unknown_type', /library\.book/)
    const editor = await author(off, 'editor')
    const admin = await author(off, 'administrator')
    const check = (user: typeof editor) =>
      (off.can as (...args: unknown[]) => boolean)(user, 'library.edit_book', book)
    expect(check(editor)).toBe(false)
    expect(check(admin)).toBe(true)
    // Trash and delete still work, so an administrator can clear them out.
    await off.content.delete(book.id)
    expect(await off.content.get(book.id)).toBeNull()
  })
})

describe('entries', () => {
  it('start as untitled drafts, and announce their first status and the save', async () => {
    const seen: string[] = []
    const watcher = plugin('watcher', {
      setup(cms) {
        cms.hooks.addAction('content.status', ({ from, to }) => void seen.push(`${from}→${to}`))
        cms.hooks.addAction('content.saved', ({ previous }) => void seen.push(`saved ${previous}`))
      },
    })
    const { content } = await site({ plugins: [watcher] })
    const entry = await content.create('core.post')
    expect(entry).toMatchObject({
      type: 'core.post',
      status: 'draft',
      slug: '',
      title: '',
      body: [],
      excerpt: '',
      authorId: null,
      parentId: null,
      position: 0,
      publishedAt: null,
      trashedFrom: null,
    })
    expect(seen).toEqual(['null→draft', 'saved null'])
    expect(await content.get(entry.id)).toEqual(entry)
  })

  it('get a slug from their title and a date when published, and keep the date after', async () => {
    const { content } = await site()
    const post = await content.create('core.post', {
      title: '  Hello, World!  ',
      status: 'published',
      body: [{ type: 'paragraph', text: 'Hi' }],
    })
    expect(post).toMatchObject({ title: 'Hello, World!', slug: 'hello-world' })
    expect(post.publishedAt).toBeInstanceOf(Date)
    const draft = await content.update(post.id, { status: 'draft' })
    expect(draft.publishedAt).toEqual(post.publishedAt)
    expect(draft.updatedAt.getTime()).toBeGreaterThanOrEqual(post.updatedAt.getTime())
    const again = await content.update(post.id, { status: 'published' })
    expect(again.publishedAt).toEqual(post.publishedAt)
  })

  it('accept a backdated publish date, but not a future one', async () => {
    const { content } = await site()
    const then = new Date('2020-01-02T03:04:05Z')
    const post = await content.create('core.post', { status: 'published', publishedAt: then })
    expect(post.publishedAt).toEqual(then)
    await refused(
      content.create('core.post', { publishedAt: new Date(Date.now() + 3_600_000) }),
      'invalid_input',
      'cannot be in the future',
    )
  })
})

describe('slugs', () => {
  it('are owned by published and private entries, numbered from 2 when taken', async () => {
    const { content } = await site()
    const first = await content.create('core.post', { title: 'News', status: 'published' })
    const second = await content.create('core.post', { title: 'News', status: 'private' })
    const page = await content.create('core.page', { title: 'News', status: 'published' })
    expect([first.slug, second.slug, page.slug]).toEqual(['news', 'news-2', 'news'])
    expect((await content.getBySlug('core.post', 'news-2'))?.id).toBe(second.id)
  })

  it("aren't owned by drafts: a draft's follows its title until it's published", async () => {
    const { content } = await site()
    const a = await content.create('core.post', { title: 'Draft', slug: 'same' })
    const b = await content.create('core.post', { title: 'Draft', slug: 'same' })
    expect([a.slug, b.slug]).toEqual(['same', 'same'])
    expect(await content.getBySlug('core.post', 'same')).toBeNull()

    const untitled = await content.create('core.post', { title: 'First idea' })
    expect(untitled.slug).toBe('')
    await content.update(untitled.id, { title: 'Better idea' })
    const published = await content.update(untitled.id, { status: 'published' })
    expect(published.slug).toBe('better-idea')

    expect((await content.update(a.id, { status: 'published' })).slug).toBe('same')
    expect((await content.update(b.id, { status: 'published' })).slug).toBe('same-2')
  })

  it('are cleaned like WordPress titles, and made from the id when nothing else is left', async () => {
    const { content } = await site()
    const set = await content.create('core.post', { slug: ' Über Uns! ', status: 'published' })
    expect(set.slug).toBe('uber-uns')
    const nothing = await content.create('core.post', { title: '???', status: 'published' })
    expect(nothing.slug).toBe(`post-${nothing.id.slice(0, 8)}`)
  })

  it('stay unique when another save takes the slug first', async () => {
    const { kernel, content } = await site()
    // Plays a second server: just before the insert, it publishes an entry with the same slug.
    // The sequence survives the rolled-back savepoint, so the thief strikes once.
    await kernel.db.execute(sql`CREATE SEQUENCE thief`)
    await kernel.db.execute(sql`
      CREATE FUNCTION steal_slug() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.status = 'published' AND nextval('thief') = 1 THEN
          INSERT INTO cms_entries (type, status, slug, title)
            VALUES (NEW.type, 'published', NEW.slug, 'Thief');
        END IF;
        RETURN NEW;
      END $$
    `)
    await kernel.db.execute(
      sql`CREATE TRIGGER steal BEFORE INSERT ON cms_entries FOR EACH ROW EXECUTE FUNCTION steal_slug()`,
    )
    const post = await content.create('core.post', { title: 'Race', status: 'published' })
    expect(post.slug).toBe('race')
    const { total } = await content.list({ type: 'core.post' })
    expect(total).toBe(1)
  })
})

describe('pages', () => {
  it('own slugs among their siblings, and are found by them level by level', async () => {
    const { content } = await site()
    const about = await content.create('core.page', { title: 'About', status: 'published' })
    const shop = await content.create('core.page', { title: 'Shop', status: 'published' })
    const aboutTeam = await content.create('core.page', {
      title: 'Team',
      parentId: about.id,
      status: 'published',
    })
    const shopTeam = await content.create('core.page', {
      title: 'Team',
      parentId: shop.id,
      status: 'published',
    })
    expect([aboutTeam.slug, shopTeam.slug]).toEqual(['team', 'team'])
    expect((await content.getBySlug('core.page', 'team', { parentId: shop.id }))?.id).toBe(
      shopTeam.id,
    )
    expect(await content.getBySlug('core.page', 'team')).toBeNull()
    expect(await content.getBySlug('core.page', 'team', { parentId: 'nope' })).toBeNull()
  })

  it('take only a page as parent, never themselves or their own descendants', async () => {
    const { content } = await site()
    const post = await content.create('core.post', { title: 'Post' })
    const a = await content.create('core.page', { title: 'A' })
    const b = await content.create('core.page', { title: 'B', parentId: a.id })
    const c = await content.create('core.page', { title: 'C', parentId: b.id })
    await refused(
      content.create('core.post', { parentId: post.id }),
      'invalid_input',
      "Posts don't have parents",
    )
    await refused(
      content.create('core.page', { parentId: post.id }),
      'invalid_input',
      'another page',
    )
    await refused(content.update(a.id, { parentId: a.id }), 'invalid_input', 'its own parent')
    await refused(content.update(a.id, { parentId: c.id }), 'invalid_input', 'own descendants')
    await content.trash(b.id)
    await refused(content.create('core.page', { parentId: b.id }), 'invalid_input', 'in the trash')
    await refused(
      content.create('core.page', { parentId: '00000000-0000-4000-8000-000000000000' }),
      'invalid_input',
      'no longer exists',
    )
  })

  it("move up to their grandparent when their parent is deleted, renamed if they'd clash", async () => {
    const deleted: Entry[] = []
    const watcher = plugin('watcher', {
      setup: (cms) =>
        cms.hooks.addAction('content.deleted', ({ entry }) => void deleted.push(entry)),
    })
    const { content } = await site({ plugins: [watcher] })
    const team = await content.create('core.page', { title: 'Team', status: 'published' })
    const about = await content.create('core.page', { title: 'About', status: 'published' })
    const child = await content.create('core.page', {
      title: 'Team',
      parentId: about.id,
      status: 'published',
    })
    const draft = await content.create('core.page', { title: 'Team', parentId: about.id })
    await content.delete(about.id)
    expect(await content.get(about.id)).toBeNull()
    expect(await content.get(child.id)).toMatchObject({ parentId: null, slug: 'team-2' })
    expect(await content.get(draft.id)).toMatchObject({ parentId: null, slug: '' })
    expect((await content.get(team.id))?.slug).toBe('team')
    expect(deleted.map((entry) => entry.id)).toEqual([about.id])
  })
})

describe('the trash', () => {
  it("keeps an entry's status for checks, frees its slug, and restores it as a draft", async () => {
    const seen: string[] = []
    const watcher = plugin('watcher', {
      setup(cms) {
        cms.hooks.addAction('content.status', ({ from, to }) => void seen.push(`${from}→${to}`))
        cms.hooks.addAction('content.trashed', () => void seen.push('trashed'))
        cms.hooks.addAction('content.restored', () => void seen.push('restored'))
      },
    })
    const { content } = await site({ plugins: [watcher] })
    const post = await content.create('core.post', { title: 'Old', status: 'published' })
    seen.length = 0
    const trashed = await content.trash(post.id)
    expect(trashed).toMatchObject({ status: 'trash', trashedFrom: 'published', slug: 'old' })
    expect(trashed.trashedAt).toBeInstanceOf(Date)
    expect(await content.trash(post.id)).toEqual(trashed)

    const reuse = await content.create('core.post', { title: 'Old', status: 'published' })
    expect(reuse.slug).toBe('old')
    await refused(content.update(post.id, { title: 'New' }), 'invalid_input', 'Restore the entry')

    const restored = await content.restore(post.id)
    expect(restored).toMatchObject({ status: 'draft', trashedFrom: null, trashedAt: null })
    expect(await content.restore(post.id)).toEqual(restored)
    expect((await content.update(post.id, { status: 'published' })).slug).toBe('old-2')
    expect(seen).toEqual([
      'published→trash',
      'trashed',
      'null→published',
      'trash→draft',
      'restored',
      'draft→published',
    ])
  })
})

describe('authors', () => {
  it('must be users, and are cleared when their account is deleted', async () => {
    const { kernel, content } = await site()
    const writer = await author(kernel)
    const post = await content.create('core.post', { authorId: writer.id })
    expect(post.authorId).toBe(writer.id)
    await refused(
      content.create('core.post', { authorId: '00000000-0000-4000-8000-000000000000' }),
      'invalid_input',
      'No user has that id',
    )
    await kernel.db.execute(sql`DELETE FROM cms_users WHERE id = ${writer.id}`)
    expect((await content.get(post.id))?.authorId).toBeNull()
  })
})

describe('input', () => {
  it.each([
    [{ status: 'trash' }, 'trash()'],
    [{ status: 'future' }, 'Unknown status "future"'],
    [{ colour: 'red' }, 'Unknown entry field "colour"'],
    [{ title: 'x'.repeat(501) }, 'limited to 500 characters'],
    [{ title: 42 }, 'The title must be text'],
    [{ body: 'Hello' }, 'list of blocks'],
    [{ body: [{ text: 'no type' }] }, 'needs a type'],
    [{ body: [{ type: 'p', text: 'nul \u0000' }] }, 'NUL'],
    [{ authorId: 'me' }, 'The author must be given by id'],
    [{ position: 1.5 }, 'whole number'],
    [{ publishedAt: 'yesterday' }, 'Invalid publish date'],
  ])('refuses %j', async (input, message) => {
    const { content } = await site()
    await refused(content.create('core.post', input as never), 'invalid_input', message)
  })

  it('is tidied: titles to one line, excerpts without control characters', async () => {
    const { content } = await site()
    const post = await content.create('core.post', {
      title: 'Two\nlines\u0007',
      excerpt: ' Keeps\nbreaks\u0007 ',
    })
    expect(post.title).toBe('Two lines')
    expect(post.excerpt).toBe('Keeps\nbreaks')
  })

  it('names entries that no longer exist', async () => {
    const { content } = await site()
    await refused(content.update('nope', {}), 'not_found', 'no longer exists')
    await refused(
      content.trash('00000000-0000-4000-8000-000000000000'),
      'not_found',
      'no longer exists',
    )
    expect(await content.get('nope')).toBeNull()
  })
})

describe('the content.entry filter', () => {
  it('changes what is saved, and its result is checked like any input', async () => {
    let shout = true
    const filters = plugin('filters', {
      setup: (cms: PluginContext) =>
        cms.hooks.addFilter('content.entry', (fields, { previous }) =>
          shout
            ? { ...fields, title: fields.title.toUpperCase(), excerpt: previous ? 'edited' : '' }
            : { ...fields, status: 'gone' as never },
        ),
    })
    const { content } = await site({ plugins: [filters] })
    const post = await content.create('core.post', { title: 'quiet' })
    expect(post.title).toBe('QUIET')
    expect((await content.update(post.id, {})).excerpt).toBe('edited')
    shout = false
    await refused(content.update(post.id, {}), 'invalid_input', 'Unknown status "gone"')
  })
})

describe('actions', () => {
  it("run in the save's transaction: their writes go with the entry's", async () => {
    const recorder = plugin('recorder', {
      setup: (cms) =>
        cms.hooks.addAction('content.saved', async ({ entry }) => {
          await cms.db.execute(
            sql`INSERT INTO cms_options (key, value) VALUES (${`seen:${entry.id}`}, ${entry.title})`,
          )
        }),
    })
    const { kernel, content } = await site({ plugins: [recorder] })
    let id = ''
    await expect(
      kernel.transaction(async () => {
        id = (await content.create('core.post', { title: 'Doomed' })).id
        throw new Error('checkout failed')
      }),
    ).rejects.toThrow('checkout failed')
    expect(await content.get(id)).toBeNull()
    const seen = await kernel.db.execute(
      sql`SELECT count(*)::int AS n FROM cms_options WHERE key LIKE 'seen:%'`,
    )
    expect((seen as unknown as { rows: { n: number }[] }).rows[0]?.n).toBe(0)
  })

  it("that fail are logged, and don't stop the save", async () => {
    const logger = memoryLogger()
    const broken = plugin('broken', {
      setup: (cms) =>
        cms.hooks.addAction('content.saved', () => {
          throw new Error('index down')
        }),
    })
    const kernel = await bootKernel({ plugins: [broken], logger })
    const post = await kernel.content.create('core.post', { title: 'Kept' })
    expect(await kernel.content.get(post.id)).toEqual(post)
    expect(logger.entries.some((entry) => entry.message.includes('content.saved'))).toBe(true)
  })
})

describe('list', () => {
  async function shelf() {
    const { kernel, content } = await site()
    const writer = await author(kernel)
    const at = (day: number) => new Date(Date.UTC(2026, 0, day))
    const b = await content.create('core.post', {
      title: 'banana',
      status: 'published',
      publishedAt: at(2),
      authorId: writer.id,
      position: 3,
    })
    const a = await content.create('core.post', {
      title: 'Apple',
      status: 'published',
      publishedAt: at(3),
      position: 2,
    })
    const c = await content.create('core.post', {
      title: 'cherry',
      authorId: writer.id,
      position: 1,
    })
    const gone = await content.create('core.post', {
      title: 'Gone',
      status: 'published',
      publishedAt: at(1),
    })
    await content.trash(gone.id)
    await content.create('core.page', { title: 'A page' })
    return { content, writer, a, b, c, gone }
  }
  const ids = (list: { entries: Entry[] }) => list.entries.map((entry) => entry.title)

  it("is a type's entries but the trash, newest first, with the total", async () => {
    const { content } = await shelf()
    const list = await content.list({ type: 'core.post' })
    expect(ids(list)).toEqual(['cherry', 'Apple', 'banana'])
    expect(list.total).toBe(3)
    expect(ids(await content.list({ type: 'core.post', status: 'trash' }))).toEqual(['Gone'])
    expect((await content.list({ type: ['core.post', 'core.page'] })).total).toBe(4)
  })

  it('filters by author, status and parent, and sorts by title or position', async () => {
    const { content, writer } = await shelf()
    expect(ids(await content.list({ type: 'core.post', authorId: writer.id }))).toEqual([
      'cherry',
      'banana',
    ])
    expect(ids(await content.list({ type: 'core.post', status: ['draft'] }))).toEqual(['cherry'])
    expect(ids(await content.list({ type: 'core.post', orderBy: 'title' }))).toEqual([
      'Apple',
      'banana',
      'cherry',
    ])
    expect(
      ids(await content.list({ type: 'core.post', orderBy: 'position', order: 'desc' })),
    ).toEqual(['banana', 'Apple', 'cherry'])
    expect((await content.list({ type: 'core.page', parentId: null })).total).toBe(1)
    expect((await content.list({ type: 'core.post', authorId: 'nobody' })).total).toBe(0)
  })

  it('pages, and still counts when the page is past the end', async () => {
    const { content } = await shelf()
    const page = await content.list({ type: 'core.post', limit: 2, offset: 1 })
    expect(ids(page)).toEqual(['Apple', 'banana'])
    expect(page.total).toBe(3)
    expect(await content.list({ type: 'core.post', offset: 10 })).toEqual({ entries: [], total: 3 })
    await refused(content.list({ type: 'core.post', limit: 101 }), 'invalid_input', '1 to 100')
    await refused(content.list({ type: [] }), 'invalid_input', 'at least one content type')
  })
})

describe('list, for the admin', () => {
  const words = (body: string) => [{ type: 'paragraph', content: [{ type: 'text', text: body }] }]

  it('searches titles, excerpts and body text, every word, with LIKE wildcards taken literally', async () => {
    const { content } = await site()
    await content.create('core.post', { title: 'Baking bread', body: words('flour and water') })
    await content.create('core.post', { title: 'Cakes', excerpt: 'Flour, sugar' })
    await content.create('core.post', { title: '100% rye', body: words('sour_dough') })
    await content.create('core.post', { title: 'Pasta', body: words('flourish') })
    const titles = async (search: string) =>
      (await content.list({ type: 'core.post', search, orderBy: 'title' })).entries.map(
        (entry) => entry.title,
      )
    expect(await titles('FLOUR')).toEqual(['Baking bread', 'Cakes', 'Pasta'])
    expect(await titles('flour water')).toEqual(['Baking bread'])
    expect(await titles('100%')).toEqual(['100% rye'])
    expect(await titles('%')).toEqual(['100% rye'])
    expect(await titles('r_dough')).toEqual(['100% rye'])
    expect(await titles('r_d')).toEqual(['100% rye'])
    expect(await titles('_')).toEqual(['100% rye'])
    expect(await titles('   ')).toHaveLength(4)
  })

  it('filters by date and by id', async () => {
    const { content } = await site()
    const at = (month: number) => new Date(Date.UTC(2026, month - 1, 15))
    const jan = await content.create('core.post', { status: 'published', publishedAt: at(1) })
    const feb = await content.create('core.post', { status: 'published', publishedAt: at(2) })
    const list = (query: object) =>
      content.list({ type: 'core.post', ...query }).then(({ entries }) => entries.map((e) => e.id))
    expect(await list({ after: new Date(Date.UTC(2026, 1, 1)) })).toEqual([feb.id])
    expect(await list({ before: new Date(Date.UTC(2026, 1, 1)) })).toEqual([jan.id])
    expect(await list({ ids: [jan.id, 'not-an-id'] })).toEqual([jan.id])
    expect(await list({ ids: [] })).toEqual([])
    await refused(
      content.list({ type: 'core.post', after: 'May' as never }),
      'invalid_input',
      'date',
    )
  })

  it('counts by status, for everyone or one author, and lists the months with entries', async () => {
    const { kernel, content } = await site()
    const writer = await author(kernel)
    await content.create('core.post', {
      status: 'published',
      publishedAt: new Date(Date.UTC(2025, 11, 31, 23)),
      authorId: writer.id,
    })
    await content.create('core.post', {
      status: 'published',
      publishedAt: new Date(Date.UTC(2026, 2, 1)),
    })
    const gone = await content.create('core.post', { authorId: writer.id })
    await content.trash(gone.id)
    expect(await content.count('core.post')).toEqual({
      draft: 0,
      pending: 0,
      published: 2,
      private: 0,
      trash: 1,
    })
    expect(await content.count('core.post', { authorId: writer.id })).toMatchObject({
      published: 1,
      trash: 1,
    })
    expect((await content.count('core.post', { authorId: 'nobody' })).published).toBe(0)
    const now = new Date()
    // In UTC: 23:00 on 31 December is December's, wherever the server is.
    expect(await content.months('core.post')).toEqual([
      { year: 2026, month: 3 },
      { year: 2025, month: 12 },
    ])
    expect(await content.months('core.post', { status: ['trash'] })).toEqual([
      { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 },
    ])
  })

  it('lists pages as a tree: parents first, siblings by order then title, with their depth', async () => {
    const { content } = await site()
    const page = (title: string, extra: object = {}) =>
      content.create('core.page', { title, status: 'published', ...extra })
    const about = await page('About', { position: 2 })
    await page('Home', { position: 1 })
    const team = await page('Team', { parentId: about.id })
    await page('Alice', { parentId: team.id })
    await page('History', { parentId: about.id })
    const draft = await content.create('core.page', { title: 'Careers', parentId: about.id })
    const tree = await content.list({ type: 'core.page', orderBy: 'tree' })
    expect(tree.entries.map((entry) => entry.title)).toEqual([
      'Home',
      'About',
      'Careers',
      'History',
      'Team',
      'Alice',
    ])
    expect(tree.depths).toEqual([0, 0, 1, 1, 1, 2])
    expect(tree.total).toBe(6)

    const drafts = await content.list({ type: 'core.page', orderBy: 'tree', status: 'draft' })
    expect(drafts).toMatchObject({ entries: [{ id: draft.id }], depths: [1], total: 1 })
    const second = await content.list({ type: 'core.page', orderBy: 'tree', limit: 2, offset: 4 })
    expect(second.entries.map((entry) => entry.title)).toEqual(['Team', 'Alice'])
    expect(await content.list({ type: 'core.page', orderBy: 'tree', offset: 50 })).toEqual({
      entries: [],
      total: 6,
      depths: [],
    })
    await refused(
      content.list({ type: ['core.page', 'core.post'], orderBy: 'tree' }),
      'invalid_input',
      'one content type',
    )
  })

  it('moves updatedAt forward on every change, by a millisecond at least', async () => {
    const { content } = await site()
    let entry = await content.create('core.post')
    for (let i = 0; i < 5; i++) {
      const next = await content.update(entry.id, { title: `v${i}` })
      expect(next.updatedAt.getTime()).toBeGreaterThan(entry.updatedAt.getTime())
      entry = next
    }
    const trashed = await content.trash(entry.id)
    expect(trashed.updatedAt.getTime()).toBeGreaterThan(entry.updatedAt.getTime())
  })
})
