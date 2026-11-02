import type { Entry } from '@otw/sdk'
import { describe, expect, it } from 'vitest'
import type { Kernel } from '../src/kernel'
import { bootKernel, formPost, plugin, redirectOf, signIn } from './helpers'

const action = (kernel: Kernel, name: string) => kernel.actionUrl('core', name)

async function post(
  kernel: Kernel,
  name: string,
  fields: Record<string, string | string[]>,
  cookie: string,
) {
  const response = await kernel.handleApi(formPost(action(kernel, name), fields, { cookie }))
  return response.status === 403
    ? { status: 403, message: undefined }
    : { status: response.status, message: redirectOf(kernel, response).flash?.message }
}

const names = async (kernel: Kernel, entry: Entry, taxonomy: 'core.category' | 'core.tag') =>
  ((await kernel.content.entryTerms([entry.id], taxonomy)).get(entry.id) ?? []).map((t) => t.name)

describe('taxonomy screens', () => {
  it('are routed under their type, for those who may manage the taxonomy', async () => {
    const kernel = await bootKernel({ plugins: [] })
    const editor = await signIn(kernel, 'editor')
    const author = await signIn(kernel, 'author')
    const news = await kernel.content.createTerm('core.category', { name: 'News' })
    const tag = await kernel.content.createTerm('core.tag', { name: 'Hot' })
    const resolve = (path: string, user = editor.user) => kernel.resolveAdminPage(path, {}, user)
    expect(await resolve('/admin/posts/categories')).toMatchObject({
      kind: 'taxonomy-terms',
      taxonomy: { name: 'core.category' },
    })
    expect(await resolve(`/admin/posts/categories/${news.id}`)).toMatchObject({
      kind: 'taxonomy-term',
      term: { id: news.id },
    })
    expect(await resolve(`/admin/posts/categories/${tag.id}`)).toEqual({ kind: 'not-found' })
    expect(await resolve('/admin/posts/tags', author.user)).toEqual({ kind: 'forbidden' })
    expect(
      kernel
        .adminMenu(author.user)
        .find((s) => s.id === 'posts')
        ?.items.map((i) => i.key),
    ).toEqual(['core.post.list', 'core.post.new'])
  })

  it("put a plugin's taxonomy under the plugin's type", async () => {
    const shelf = plugin('shelf', {
      setup(cms) {
        cms.content.type('book', { labels: { singular: 'Book', plural: 'Books' }, public: true })
        cms.content.taxonomy('genre', {
          labels: { singular: 'Genre', plural: 'Genres' },
          types: ['shelf.book' as never],
        })
      },
    })
    const kernel = await bootKernel({ plugins: [shelf] })
    const menu = kernel.adminMenu((await signIn(kernel)).user)
    expect(menu.find((s) => s.id === 'shelf')?.items.map((i) => i.url)).toEqual([
      '/admin/shelf/books',
      '/admin/shelf/books/new',
      '/admin/shelf/books/genres',
    ])
  })
})

describe('term actions', () => {
  it('add, update and delete terms for those who may', async () => {
    const kernel = await bootKernel({ plugins: [] })
    const editor = await signIn(kernel, 'editor')
    const author = await signIn(kernel, 'author')
    const add = (fields: Record<string, string>, cookie = editor.cookie) =>
      post(kernel, 'create-term', { taxonomy: 'core.category', ...fields }, cookie)
    expect((await add({ name: 'News', description: 'Daily' })).message).toBe('Category added.')
    expect((await add({ name: 'news' })).message).toBe('A category called “news” is already there')
    expect((await add({ name: 'Sport' }, author.cookie)).status).toBe(403)
    const news = (await kernel.content.getTermBySlug('core.category', 'news'))!

    const update = await post(
      kernel,
      'update-term',
      { id: news.id, name: 'World news', slug: '', description: 'Daily', parent: '' },
      editor.cookie,
    )
    expect(update.message).toBe('Category updated.')
    expect(await kernel.content.getTerm(news.id)).toMatchObject({
      name: 'World news',
      slug: 'world-news',
    })

    const fallback = await kernel.content.createTerm('core.category', { name: 'Uncategorized' })
    expect((await post(kernel, 'delete-term', { id: fallback.id }, editor.cookie)).status).toBe(403)
    const deleted = await post(
      kernel,
      'delete-term',
      { id: news.id, redirect: '/admin/posts/categories' },
      editor.cookie,
    )
    expect(deleted.message).toBe('Category deleted.')
    expect(await kernel.content.getTerm(news.id)).toBeNull()
  })

  it('delete the selected terms in bulk, skipping those that may not be deleted', async () => {
    const kernel = await bootKernel({ plugins: [] })
    const editor = await signIn(kernel, 'editor')
    const a = await kernel.content.createTerm('core.category', { name: 'A' })
    const fallback = await kernel.content.createTerm('core.category', { name: 'Uncategorized' })
    const result = await post(
      kernel,
      'bulk-terms',
      { taxonomy: 'core.category', bulk: 'delete', ids: [a.id, fallback.id] },
      editor.cookie,
    )
    expect(result.message).toBe(
      '1 category deleted. 1 skipped: you may not change it, or it is gone.',
    )
  })
})

describe('saving an entry with its terms', () => {
  it('sets the ticked categories and the typed tags, adding new tags as WordPress does', async () => {
    const kernel = await bootKernel({ plugins: [] })
    const author = await signIn(kernel, 'author')
    const news = await kernel.content.createTerm('core.category', { name: 'News' })
    const saved = await post(
      kernel,
      'save-entry',
      {
        type: 'core.post',
        title: 'Hello',
        slug: '',
        taxonomies: ['core.category', 'core.tag'],
        'terms.core.category': [news.id],
        'tags.core.tag': 'Summer, local events, summer',
      },
      author.cookie,
    )
    expect(saved.message).toBe('Post draft updated.')
    const entry = (await kernel.content.list({ type: 'core.post' })).entries[0]!
    expect(await names(kernel, entry, 'core.category')).toEqual(['News'])
    expect(await names(kernel, entry, 'core.tag')).toEqual(['local events', 'Summer'])

    // Nothing ticked: the default category, as WordPress gives it.
    await post(
      kernel,
      'save-entry',
      {
        type: 'core.post',
        id: entry.id,
        updatedAt: (await kernel.content.get(entry.id))!.updatedAt.toISOString(),
        title: 'Hello',
        slug: '',
        taxonomies: ['core.category'],
      },
      author.cookie,
    )
    expect(await names(kernel, entry, 'core.category')).toEqual(['Uncategorized'])
    expect(await names(kernel, entry, 'core.tag')).toEqual(['local events', 'Summer'])
  })

  it('needs the taxonomy’s assign capability for each box the form had', async () => {
    const writers = plugin('writers', {
      setup: (cms) =>
        cms.auth.role('writer', {
          label: 'Writer',
          capabilities: ['core.access_admin', 'core.edit_posts'],
        }),
    })
    const kernel = await bootKernel({ plugins: [writers] })
    const writer = await signIn(kernel, 'writer')
    const fields = { type: 'core.post', title: 'Mine', slug: '' }
    expect((await post(kernel, 'save-entry', fields, writer.cookie)).message).toBe(
      'Post draft updated.',
    )
    const tagged = { ...fields, taxonomies: 'core.tag', 'tags.core.tag': 'x' }
    expect((await post(kernel, 'save-entry', tagged, writer.cookie)).status).toBe(403)
  })
})
