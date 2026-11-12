import { ActionError, defineAdmin, type AdminDefinition, type Entry } from '@otwdesign/sdk'
import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { STALE_MESSAGE } from '../src/content-actions'
import type { Kernel } from '../src/kernel'
import { bootKernel, formPost, plugin, redirectOf, signIn } from './helpers'

declare module '@otwdesign/sdk' {
  interface ContentTypes {
    'library.book': true
    'library.album': true
    'library.loan': true
  }
}

const books = { labels: { singular: 'Book', plural: 'Books' }, public: true }
const library = plugin('library', {
  setup(cms) {
    cms.content.type('book', books)
    cms.content.type('album', { ...books, labels: { singular: 'Album', plural: 'Albums' } })
    // Not public: no screens, as WordPress's show_ui follows public.
    cms.content.type('loan', { labels: { singular: 'Loan', plural: 'Loans' } })
  },
})

function site(admin: AdminDefinition[] = []) {
  return bootKernel({ plugins: [library], admin })
}

const action = (kernel: Kernel, name: string) => kernel.actionUrl('core', name)
const body = (text: string) =>
  JSON.stringify([{ type: 'paragraph', content: [{ type: 'text', text }] }])

/** Posts the edit screen's form as `cookie`'s user, with the hidden fields it carries. */
async function save(kernel: Kernel, cookie: string, fields: Record<string, string>, entry?: Entry) {
  const hidden: Record<string, string> = entry
    ? { id: entry.id, updatedAt: entry.updatedAt.toISOString(), type: entry.type }
    : { type: 'core.post' }
  const response = await kernel.handleApi(
    formPost(
      action(kernel, 'save-entry'),
      { title: '', slug: '', ...hidden, ...fields },
      { cookie },
    ),
  )
  if (response.status === 403) return { status: 403 as const }
  const { path, flash } = redirectOf(kernel, response)
  const id = /\/([0-9a-f-]{36})$/.exec(path)?.[1]
  return { status: response.status, path, flash, entry: id ? await kernel.content.get(id) : null }
}

describe('content screens', () => {
  it("are routed for types with screens: a plugin's under its admin path, core's at the top", async () => {
    const kernel = await site()
    const { user } = await signIn(kernel)
    const book = await kernel.content.create('library.book', { title: 'Dune' })
    const resolve = (path: string) => kernel.resolveAdminPage(path, {}, user)

    expect(kernel.content.getType('library.book')?.adminPath).toBe('/admin/library/books')
    expect(kernel.content.getType('core.post')?.adminPath).toBe('/admin/posts')
    expect(kernel.content.getType('library.loan')?.adminPath).toBeNull()
    expect(await resolve('/admin/library/books')).toMatchObject({
      kind: 'content-list',
      type: { name: 'library.book' },
    })
    expect(await resolve('/admin/library/books/new')).toMatchObject({
      kind: 'content-edit',
      entry: null,
    })
    expect(await resolve(`/admin/library/books/${book.id}`)).toMatchObject({
      kind: 'content-edit',
      entry: { id: book.id },
    })
    expect(await resolve(`/admin/posts/${book.id}`)).toEqual({ kind: 'not-found' })
    expect(await resolve('/admin/posts/nope')).toEqual({ kind: 'not-found' })
    expect(await resolve('/admin/library/loans')).toEqual({ kind: 'not-found' })
    expect(kernel.adminUrl('library.book.edit', { id: book.id })).toBe(
      `/admin/library/books/${book.id}`,
    )
  })

  it("need the type's capability, and to edit an entry, its meta capability", async () => {
    const kernel = await site()
    const contributor = await signIn(kernel, 'contributor')
    const resolve = (path: string, user = contributor.user) =>
      kernel.resolveAdminPage(path, {}, user)
    const own = await kernel.content.create('core.post', { authorId: contributor.user.id })
    const others = await kernel.content.create('core.post', { status: 'published' })

    expect((await resolve('/admin/posts')).kind).toBe('content-list')
    expect((await resolve(`/admin/posts/${own.id}`)).kind).toBe('content-edit')
    expect(await resolve(`/admin/posts/${others.id}`)).toEqual({ kind: 'forbidden' })
    // Pages are editors'.
    expect(await resolve('/admin/pages')).toEqual({ kind: 'forbidden' })
    const customer = await signIn(kernel, 'customer')
    expect(await resolve('/admin/posts', customer.user)).toEqual({ kind: 'forbidden' })
  })

  it("put a plugin's types first in its section, and leave out those that say so", async () => {
    const quiet = plugin('quiet', {
      setup: (cms) => cms.content.type('note', { ...books, showInMenu: false }),
    })
    const kernel = await bootKernel({
      plugins: [library, quiet],
      admin: [
        defineAdmin(library, (cms) =>
          cms.admin.page({
            name: 'reports',
            path: '/reports',
            title: 'Reports',
            capability: 'core.access_admin',
            menu: { label: 'Reports' },
            component: () => null,
          }),
        ),
      ],
    })
    const menu = kernel.adminMenu((await signIn(kernel)).user)
    const items = (id: string) => menu.find((section) => section.id === id)?.items
    expect(items('library')).toEqual([
      { key: 'library.book.list', label: 'All Books', url: '/admin/library/books' },
      { key: 'library.book.new', label: 'Add New Book', url: '/admin/library/books/new' },
      { key: 'library.album.list', label: 'All Albums', url: '/admin/library/albums' },
      { key: 'library.album.new', label: 'Add New Album', url: '/admin/library/albums/new' },
      { key: 'library.reports', label: 'Reports', url: '/admin/library/reports' },
    ])
    expect(items('quiet')).toBeUndefined()
    expect(
      (await kernel.resolveAdminPage('/admin/quiet/notes', {}, (await signIn(kernel)).user)).kind,
    ).toBe('content-list')
  })

  it("clash with a plugin page at a type's path", async () => {
    await expect(
      site([
        defineAdmin(library, (cms) =>
          cms.admin.page({
            name: 'books',
            path: '/books',
            title: 'Books',
            capability: 'core.access_admin',
            component: () => null,
          }),
        ),
      ]),
    ).rejects.toThrow('conflicts with "library.book.list"')
  })

  it('take columns, meta boxes, row and bulk actions from admin entries, by type', async () => {
    const kernel = await site([
      defineAdmin(library, (cms) => {
        cms.admin.column('library.book', { name: 'isbn', label: 'ISBN', render: () => 'x' })
        cms.admin.column('*', { name: 'words', label: 'Words', render: () => '1' })
        cms.admin.metaBox(['library.book', 'core.post'], {
          name: 'notes',
          title: 'Notes',
          context: 'side',
          component: () => null,
        })
        cms.admin.metaBox('library.book', {
          name: 'first',
          title: 'First',
          order: 1,
          component: () => null,
        })
        cms.admin.rowAction('library.book', { name: 'lend', link: () => null })
        cms.admin.bulkAction('library.book', {
          name: 'shelve',
          label: 'Shelve',
          capability: 'library.edit_books',
          handler: () => 'Shelved.',
        })
      }),
    ])
    const book = kernel.contentScreens('library.book')
    expect(book.columns.map((column) => column.key)).toEqual(['library.isbn', 'library.words'])
    expect(book.metaBoxes.map((box) => box.key)).toEqual(['library.first', 'library.notes'])
    expect(book.rowActions.map((row) => row.key)).toEqual(['library.lend'])
    expect(book.bulkActions.map((bulk) => bulk.key)).toEqual(['library.shelve'])
    const post = kernel.contentScreens('core.post')
    expect(post.columns.map((column) => column.key)).toEqual(['library.words'])
    expect(post.metaBoxes.map((box) => box.key)).toEqual(['library.notes'])
  })

  it('refuse extensions from setup(), and a second of the same name', async () => {
    const early = plugin('early', {
      setup: (cms) => cms.admin.column('*', { name: 'x', label: 'X', render: () => null }),
    })
    await expect(bootKernel({ plugins: [early] })).rejects.toThrow(
      'Register column "early.x" in the plugin\'s admin entry',
    )
    await expect(
      site([
        defineAdmin(library, (cms) => {
          cms.admin.metaBox('*', { name: 'x', title: 'X', component: () => null })
          cms.admin.metaBox('*', { name: 'x', title: 'X', component: () => null })
        }),
      ]),
    ).rejects.toThrow('The meta box "library.x" is already registered')
  })
})

describe('saving from the edit screen', () => {
  it('creates the entry on first save, written by the user, and opens its edit screen', async () => {
    const kernel = await site()
    const author = await signIn(kernel, 'author')
    const saved = await save(kernel, author.cookie, { title: 'Hello', body: body('Hi') })
    expect(saved.path).toBe(`/admin/posts/${saved.entry!.id}`)
    expect(saved.flash).toEqual({ kind: 'notice', message: 'Post draft updated.' })
    expect(saved.entry).toMatchObject({
      title: 'Hello',
      status: 'draft',
      authorId: author.user.id,
      body: JSON.parse(body('Hi')),
    })
  })

  it('publishes for those who may, and submits for review for those who may not', async () => {
    const kernel = await site()
    const author = await signIn(kernel, 'author')
    const contributor = await signIn(kernel, 'contributor')
    const published = await save(kernel, author.cookie, { title: 'A', intent: 'publish' })
    expect(published.entry?.status).toBe('published')
    expect(published.flash?.message).toBe('Post published.')
    const submitted = await save(kernel, contributor.cookie, { title: 'C', intent: 'publish' })
    expect(submitted.entry?.status).toBe('pending')
    expect(submitted.flash?.message).toBe('Post submitted.')
    const sneaky = await save(kernel, contributor.cookie, { title: 'D', status: 'published' })
    expect(sneaky.entry?.status).toBe('pending')
  })

  it('keeps a published entry published on Update, unless the dropdown or visibility change it', async () => {
    const kernel = await site()
    const author = await signIn(kernel, 'author')
    let { entry } = await save(kernel, author.cookie, { title: 'A', intent: 'publish' })
    const updated = await save(kernel, author.cookie, { title: 'A2' }, entry!)
    expect([updated.entry?.status, updated.flash?.message]).toEqual(['published', 'Post updated.'])
    entry = updated.entry
    const hidden = await save(kernel, author.cookie, { title: 'A2', visibility: 'private' }, entry!)
    expect([hidden.entry?.status, hidden.flash?.message]).toEqual([
      'private',
      'Post published privately.',
    ])
    const draft = await save(kernel, author.cookie, { title: 'A2', status: 'draft' }, hidden.entry!)
    expect(draft.entry?.status).toBe('draft')
  })

  it('schedules an entry whose date is ahead, for those who may publish', async () => {
    const kernel = await site()
    const author = await signIn(kernel, 'author')
    const contributor = await signIn(kernel, 'contributor')
    const date = '2031-05-06T09:30'
    const at = new Date('2031-05-06T09:30:00Z')

    const scheduled = await save(kernel, author.cookie, { title: 'A', intent: 'publish', date })
    expect(scheduled.entry).toMatchObject({ status: 'scheduled', publishedAt: at, slug: 'a' })
    expect(scheduled.flash?.message).toBe('Post scheduled for: May 6, 2031, 9:30 AM UTC.')

    // Without the capability the date isn't theirs to set, and Publish submits for review.
    const submitted = await save(kernel, contributor.cookie, {
      title: 'C',
      intent: 'publish',
      date,
    })
    expect(submitted.entry).toMatchObject({ status: 'pending', publishedAt: null })
  })

  it('keeps a scheduled entry scheduled on Update, and follows its date', async () => {
    const kernel = await site()
    const author = await signIn(kernel, 'author')
    const date = '2031-05-06T09:30'
    let { entry } = await save(kernel, author.cookie, { title: 'A', intent: 'publish', date })

    // As the screen sends it back: the dropdown's Scheduled, and the date it showed.
    const same = await save(
      kernel,
      author.cookie,
      { title: 'A2', status: 'scheduled', date },
      entry!,
    )
    expect([same.entry?.status, same.flash?.message]).toEqual(['scheduled', 'Post updated.'])
    entry = same.entry

    const moved = await save(
      kernel,
      author.cookie,
      { title: 'A2', status: 'scheduled', date: '2031-06-01T08:00' },
      entry!,
    )
    expect(moved.entry?.publishedAt).toEqual(new Date('2031-06-01T08:00:00Z'))
    expect(moved.flash?.message).toBe('Post scheduled for: Jun 1, 2031, 8:00 AM UTC.')
    entry = moved.entry

    // An emptied date leaves a scheduled entry's alone; a date that has come publishes it.
    const emptied = await save(
      kernel,
      author.cookie,
      { title: 'A2', status: 'scheduled', date: '' },
      entry!,
    )
    expect(emptied.entry).toMatchObject({ status: 'scheduled', publishedAt: entry!.publishedAt })
    const now = await save(
      kernel,
      author.cookie,
      { title: 'A2', status: 'scheduled', date: '2020-01-02T03:04' },
      emptied.entry!,
    )
    expect(now.entry).toMatchObject({
      status: 'published',
      publishedAt: new Date('2020-01-02T03:04:00Z'),
    })
    expect(now.flash?.message).toBe('Post published.')
  })

  it('takes a scheduled entry back to a draft, and schedules a published one given a date ahead', async () => {
    const kernel = await site()
    const author = await signIn(kernel, 'author')
    const date = '2031-05-06T09:30'
    const scheduled = await save(kernel, author.cookie, { title: 'A', intent: 'publish', date })
    const draft = await save(
      kernel,
      author.cookie,
      { title: 'A', status: 'draft', date },
      scheduled.entry!,
    )
    expect(draft.entry?.status).toBe('draft')
    // Its date stays for when it's published, until the field is emptied: "immediately".
    expect(draft.entry?.publishedAt).toEqual(new Date('2031-05-06T09:30:00Z'))
    const cleared = await save(
      kernel,
      author.cookie,
      { title: 'A', status: 'draft', date: '' },
      draft.entry!,
    )
    expect(cleared.entry?.publishedAt).toBeNull()

    const published = await save(kernel, author.cookie, { title: 'B', intent: 'publish' })
    const later = await save(
      kernel,
      author.cookie,
      { title: 'B', status: 'published', date },
      published.entry!,
    )
    expect(later.entry?.status).toBe('scheduled')
    expect(later.flash?.message).toBe('Post scheduled for: May 6, 2031, 9:30 AM UTC.')
  })

  it('backdates with the date field, keeps the seconds of a date it only showed, and refuses one it can’t read', async () => {
    const kernel = await site()
    const author = await signIn(kernel, 'author')
    const published = await save(kernel, author.cookie, { title: 'A', intent: 'publish' })
    const first = published.entry!.publishedAt!
    // The field holds minutes: sent back unchanged, the entry keeps the moment it was published.
    const shown = first.toISOString().slice(0, 16)
    const same = await save(kernel, author.cookie, { title: 'A2', date: shown }, published.entry!)
    expect(same.entry?.publishedAt).toEqual(first)

    const backdated = await save(
      kernel,
      author.cookie,
      { title: 'A2', date: '2019-12-31T23:59' },
      same.entry!,
    )
    expect(backdated.entry).toMatchObject({
      status: 'published',
      publishedAt: new Date('2019-12-31T23:59:00Z'),
    })
    expect(backdated.flash?.message).toBe('Post updated.')

    for (const date of ['next tuesday', '2026-02-31T10:00', '2026-13-01T10:00']) {
      const refused = await save(kernel, author.cookie, { title: 'A3', date }, backdated.entry!)
      expect(refused.flash).toEqual({
        kind: 'error',
        message: 'The publish date could not be read. Use a date and time.',
      })
    }
  })

  it('refuses what the user may not do, whatever the form says', async () => {
    const kernel = await site()
    const author = await signIn(kernel, 'author')
    const editor = await signIn(kernel, 'editor')
    const contributor = await signIn(kernel, 'contributor')
    const theirs = await kernel.content.create('core.post', { authorId: editor.user.id })
    expect((await save(kernel, author.cookie, { title: 'Mine now' }, theirs)).status).toBe(403)
    expect((await save(kernel, author.cookie, { title: 'X', author: editor.user.id })).status).toBe(
      403,
    )
    expect((await save(kernel, contributor.cookie, { type: 'core.page', title: 'P' })).status).toBe(
      403,
    )
    const reassigned = await save(
      kernel,
      editor.cookie,
      { title: 'T', author: author.user.id },
      theirs,
    )
    expect(reassigned.entry?.authorId).toBe(author.user.id)
  })

  it('refuses a stale form, and changes to an entry in the trash', async () => {
    const kernel = await site()
    const { cookie } = await signIn(kernel, 'editor')
    const post = await kernel.content.create('core.post', { title: 'Old' })
    await kernel.content.update(post.id, { title: 'Changed elsewhere' })
    const stale = await save(kernel, cookie, { title: 'Mine' }, post)
    expect(stale.flash).toEqual({ kind: 'error', message: STALE_MESSAGE })
    expect((await kernel.content.get(post.id))?.title).toBe('Changed elsewhere')

    const trashed = await kernel.content.trash(post.id)
    const refused = await save(kernel, cookie, { title: 'Mine' }, trashed)
    expect(refused.flash?.message).toBe('This post is in the Trash. Restore it to edit it.')
  })

  it("sends the content service's objections back to the form", async () => {
    const kernel = await site()
    const { cookie } = await signIn(kernel, 'editor')
    const post = await kernel.content.create('core.post')
    const link = JSON.stringify([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'javascript:x' } }] },
        ],
      },
    ])
    expect((await save(kernel, cookie, { body: '{' })).flash?.message).toBe(
      'The content could not be read. Reload the screen and try again.',
    )
    expect((await save(kernel, cookie, { body: link })).flash?.message).toMatch(/^Links must be/)
    expect(
      (await save(kernel, cookie, { type: 'core.page', parent: post.id })).flash?.message,
    ).toBe('The parent must be another page')
  })

  it('saves meta boxes with the entry, and rolls the entry back when one refuses', async () => {
    const kernel = await site([
      defineAdmin(library, (cms) =>
        cms.admin.metaBox('core.post', {
          name: 'subtitle',
          title: 'Subtitle',
          component: () => null,
          async save({ entry, form }) {
            const subtitle = String(form.get('library.subtitle') ?? '')
            if (subtitle === 'no') throw new ActionError('Not that subtitle.')
            await cms.db.execute(
              sql`INSERT INTO cms_options (key, value) VALUES (${`subtitle:${entry.id}`}, ${subtitle})
                  ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
            )
          },
        }),
      ),
    ])
    const { cookie } = await signIn(kernel, 'editor')
    const saved = await save(kernel, cookie, { title: 'A', 'library.subtitle': 'Sub' })
    const option = async (id: string) =>
      (
        (await kernel.db.execute(
          sql`SELECT value FROM cms_options WHERE key = ${`subtitle:${id}`}`,
        )) as unknown as { rows: { value: string }[] }
      ).rows[0]?.value
    expect(await option(saved.entry!.id)).toBe('Sub')
    const refused = await save(
      kernel,
      cookie,
      { title: 'B', 'library.subtitle': 'no' },
      saved.entry!,
    )
    expect(refused.flash?.message).toBe('Not that subtitle.')
    expect((await kernel.content.get(saved.entry!.id))?.title).toBe('A')
    expect(await option(saved.entry!.id)).toBe('Sub')
  })
})

describe('trash, restore, delete and bulk actions', () => {
  const post = (
    kernel: Kernel,
    name: string,
    fields: Record<string, string | string[]>,
    cookie: string,
  ) => kernel.handleApi(formPost(action(kernel, name), fields, { cookie }))

  it('move one entry, if the user may delete it, and go where the form says', async () => {
    const kernel = await site()
    const contributor = await signIn(kernel, 'contributor')
    const draft = await kernel.content.create('core.post', { authorId: contributor.user.id })
    const live = await kernel.content.create('core.post', {
      authorId: contributor.user.id,
      status: 'published',
    })
    const trashed = redirectOf(
      kernel,
      await post(
        kernel,
        'trash-entry',
        { id: draft.id, redirect: '/admin/posts' },
        contributor.cookie,
      ),
    )
    expect(trashed).toMatchObject({
      path: '/admin/posts',
      flash: { message: '1 post moved to the Trash.' },
    })
    // Contributors can't delete what's published, even their own.
    expect((await post(kernel, 'trash-entry', { id: live.id }, contributor.cookie)).status).toBe(
      403,
    )
    const restored = redirectOf(
      kernel,
      await post(kernel, 'restore-entry', { id: draft.id }, contributor.cookie),
    )
    expect(restored.flash?.message).toBe('1 post restored from the Trash.')
    const deleted = redirectOf(
      kernel,
      await post(kernel, 'delete-entry', { id: draft.id }, contributor.cookie),
    )
    expect(deleted.flash?.message).toBe('1 post permanently deleted.')
    expect(await kernel.content.get(draft.id)).toBeNull()
  })

  it('apply to the selected entries the user may change, and say how many were skipped', async () => {
    const kernel = await site()
    const author = await signIn(kernel, 'author')
    const mine = await kernel.content.create('core.post', { authorId: author.user.id })
    const theirs = await kernel.content.create('core.post')
    const bulk = (fields: Record<string, string | string[]>) =>
      post(kernel, 'bulk-entries', { type: 'core.post', ...fields }, author.cookie).then(
        (response) => redirectOf(kernel, response).flash?.message,
      )
    expect(await bulk({ bulk: 'trash', ids: [mine.id, theirs.id] })).toBe(
      '1 post moved to the Trash. 1 skipped: you may not change it, or it is gone.',
    )
    expect(await bulk({ bulk: 'delete', ids: [mine.id] })).toBe('1 post permanently deleted.')
    expect(await bulk({ bulk: 'trash' })).toBe('Select the posts to change.')
    expect(await bulk({ ids: [theirs.id] })).toBe('Choose a bulk action.')
  })

  it('empty the trash of what the user may delete', async () => {
    const kernel = await site()
    const author = await signIn(kernel, 'author')
    for (let i = 0; i < 3; i++) {
      const entry = await kernel.content.create('core.post', { authorId: author.user.id })
      await kernel.content.trash(entry.id)
    }
    const theirs = await kernel.content.create('core.post')
    await kernel.content.trash(theirs.id)
    const response = await post(
      kernel,
      'bulk-entries',
      { type: 'core.post', bulk: 'empty-trash' },
      author.cookie,
    )
    expect(redirectOf(kernel, response).flash?.message).toBe(
      '3 posts permanently deleted. 1 skipped: you may not change it, or it is gone.',
    )
    expect((await kernel.content.count('core.post')).trash).toBe(1)
  })

  it("run a plugin's bulk action for those with its capability", async () => {
    const seen: string[] = []
    const kernel = await site([
      defineAdmin(library, (cms) =>
        cms.admin.bulkAction('library.book', {
          name: 'shelve',
          label: 'Shelve',
          capability: 'library.edit_others_books',
          handler: ({ entries }) => {
            seen.push(...entries.map((entry) => entry.title))
            return `${entries.length} shelved.`
          },
        }),
      ),
    ])
    const book = await kernel.content.create('library.book', { title: 'Dune' })
    const editor = await signIn(kernel, 'editor')
    const author = await signIn(kernel, 'author')
    const fields = { type: 'library.book', bulk: 'library.shelve', ids: [book.id] }
    const ok = await post(kernel, 'bulk-entries', fields, editor.cookie)
    expect(redirectOf(kernel, ok).flash?.message).toBe('1 shelved.')
    expect(seen).toEqual(['Dune'])
    expect((await post(kernel, 'bulk-entries', fields, author.cookie)).status).toBe(403)
  })
})
