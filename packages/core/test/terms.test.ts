import { ContentError, type Term } from '@otwdesign/sdk'
import { describe, expect, it } from 'vitest'
import { bootKernel, plugin } from './helpers'

declare module '@otwdesign/sdk' {
  interface Taxonomies {
    'shelf.genre': true
  }
  interface ContentTypes {
    'shelf.book': true
  }
}

const shelf = plugin('shelf', {
  setup(cms) {
    cms.content.type('book', { labels: { singular: 'Book', plural: 'Books' }, public: true })
    cms.content.taxonomy('genre', {
      labels: { singular: 'Genre', plural: 'Genres' },
      types: ['shelf.book'],
      hierarchical: true,
    })
  },
})

async function site() {
  const kernel = await bootKernel({ plugins: [shelf] })
  return { kernel, content: kernel.content }
}

async function refused(
  promise: Promise<unknown>,
  message: string | RegExp,
  code = 'invalid_input',
) {
  const error = await promise.then(
    () => expect.fail('expected a ContentError'),
    (error: unknown) => error,
  )
  expect(error).toBeInstanceOf(ContentError)
  expect((error as ContentError).code).toBe(code)
  expect((error as ContentError).message).toMatch(message)
}

const names = (terms: readonly Term[]) => terms.map((term) => term.name)

describe('terms', () => {
  it('get a slug from their name, unique in their taxonomy, and refuse a sibling’s name', async () => {
    const { content } = await site()
    const news = await content.createTerm('core.category', { name: '  Café News ' })
    expect(news).toMatchObject({ name: 'Café News', slug: 'cafe-news', parentId: null })
    const local = await content.createTerm('core.category', { name: 'Local', parentId: news.id })
    const again = await content.createTerm('core.category', {
      name: 'Cafe news',
      slug: 'cafe-news',
      parentId: local.id,
    })
    expect(again.slug).toBe('cafe-news-2')
    // Tags have their own slugs.
    expect((await content.createTerm('core.tag', { name: 'Café News' })).slug).toBe('cafe-news')
    await refused(
      content.createTerm('core.category', { name: 'CAFÉ NEWS' }),
      'called “CAFÉ NEWS” is already there',
    )
    await refused(content.createTerm('core.category', { name: ' ' }), 'needs a name')
    await refused(
      content.createTerm('core.tag', { name: 'Child', parentId: news.id }),
      "Tags don't have parents",
    )
    await refused(
      content.createTerm('shelf.genre', { name: 'X', parentId: news.id }),
      'another genre',
    )
    await refused(
      content.createTerm('core.nope' as never, { name: 'X' }),
      /taxonomy "core.nope"/,
      'unknown_type',
    )
  })

  it('refuse a loop of parents, and keep the default term’s slug', async () => {
    const { kernel, content } = await site()
    const a = await content.createTerm('core.category', { name: 'A' })
    const b = await content.createTerm('core.category', { name: 'B', parentId: a.id })
    await refused(content.updateTerm(a.id, { parentId: b.id }), 'own children')
    await refused(content.updateTerm(a.id, { parentId: a.id }), 'its own parent')
    const post = await content.create('core.post')
    const [fallback] = (await content.entryTerms([post.id], 'core.category')).get(post.id)!
    expect(fallback).toMatchObject({ name: 'Uncategorized', slug: 'uncategorized' })
    const renamed = await content.updateTerm(fallback!.id, { name: 'General' })
    expect(renamed).toMatchObject({ name: 'General', slug: 'uncategorized' })
    await refused(content.updateTerm(fallback!.id, { slug: 'general' }), 'keeps its slug')
    await refused(content.deleteTerm(fallback!.id), 'cannot be deleted')
    expect(kernel.isActive('shelf')).toBe(true)
  })

  it('are deleted as WordPress deletes them: children move up, lonely entries get the default', async () => {
    const deleted: string[] = []
    const watcher = plugin('watcher', {
      setup: (cms) =>
        cms.hooks.addAction('content.term.deleted', ({ term }) => void deleted.push(term.name)),
    })
    const kernel = await bootKernel({ plugins: [watcher] })
    const { content } = kernel
    const news = await content.createTerm('core.category', { name: 'News' })
    const local = await content.createTerm('core.category', { name: 'Local', parentId: news.id })
    const sport = await content.createTerm('core.category', { name: 'Sport' })
    const only = await content.create('core.post')
    const both = await content.create('core.post')
    await content.setEntryTerms(only.id, 'core.category', { ids: [news.id] })
    await content.setEntryTerms(both.id, 'core.category', { ids: [news.id, sport.id] })

    await content.deleteTerm(news.id)
    expect((await content.getTerm(local.id))?.parentId).toBeNull()
    const terms = await content.entryTerms([only.id, both.id], 'core.category')
    expect(names(terms.get(only.id)!)).toEqual(['Uncategorized'])
    expect(names(terms.get(both.id)!)).toEqual(['Sport'])
    expect(deleted).toEqual(['News'])
  })

  it('are listed with counts of published entries, by name, count, search or as a tree', async () => {
    const { content } = await site()
    const fiction = await content.createTerm('shelf.genre', { name: 'Fiction' })
    const crime = await content.createTerm('shelf.genre', { name: 'crime', parentId: fiction.id })
    const poetry = await content.createTerm('shelf.genre', {
      name: 'Poetry',
      description: '100% verse',
    })
    for (const [status, genre] of [
      ['published', crime],
      ['published', crime],
      ['draft', crime],
      ['published', poetry],
    ] as const) {
      const book = await content.create('shelf.book', { status, title: 'Book' })
      await content.setEntryTerms(book.id, 'shelf.genre', { ids: [genre.id] })
    }
    const byName = await content.listTerms({ taxonomy: 'shelf.genre' })
    expect(names(byName.terms)).toEqual(['crime', 'Fiction', 'Poetry'])
    expect(byName.counts).toEqual([2, 0, 1])
    expect(byName.total).toBe(3)
    expect(
      names((await content.listTerms({ taxonomy: 'shelf.genre', orderBy: 'count' })).terms),
    ).toEqual(['crime', 'Poetry', 'Fiction'])
    expect(
      names((await content.listTerms({ taxonomy: 'shelf.genre', hideEmpty: true })).terms),
    ).toEqual(['crime', 'Poetry'])
    expect(
      names((await content.listTerms({ taxonomy: 'shelf.genre', search: '100%' })).terms),
    ).toEqual(['Poetry'])
    const tree = await content.listTerms({ taxonomy: 'shelf.genre', orderBy: 'tree' })
    expect(names(tree.terms)).toEqual(['Fiction', 'crime', 'Poetry'])
    expect(tree.depths).toEqual([0, 1, 0])
    expect(tree.counts).toEqual([0, 2, 1])
    expect(await content.listTerms({ taxonomy: 'shelf.genre', offset: 9 })).toEqual({
      terms: [],
      counts: [],
      total: 3,
    })
  })
})

describe("entries' terms", () => {
  it('are set by id, or by name for new tags, and replaced each time', async () => {
    const seen: number[] = []
    const watcher = plugin('watcher', {
      setup: (cms) =>
        cms.hooks.addAction('content.entry.terms', ({ terms }) => void seen.push(terms.length)),
    })
    const kernel = await bootKernel({ plugins: [watcher] })
    const { content } = kernel
    const post = await content.create('core.post')
    const existing = await content.createTerm('core.tag', { name: 'Recipes' })
    const set = await content.setEntryTerms(post.id, 'core.tag', {
      names: ['recipes', 'Summer', 'summer '],
    })
    expect(names(set)).toEqual(['Recipes', 'Summer'])
    expect(set[0]!.id).toBe(existing.id)
    expect(names(await content.setEntryTerms(post.id, 'core.tag', { ids: [existing.id] }))).toEqual(
      ['Recipes'],
    )
    expect(await content.setEntryTerms(post.id, 'core.tag', {})).toEqual([])
    expect(seen).toEqual([2, 1, 0])
    await refused(
      content.setEntryTerms(post.id, 'core.tag', { ids: ['00000000-0000-4000-8000-000000000000'] }),
      'Unknown tag',
    )
    const page = await content.create('core.page')
    await refused(content.setEntryTerms(page.id, 'core.tag', { names: ['x'] }), "don't classify")
    await refused(content.setEntryTerms('nope', 'core.tag', {}), 'no longer exists', 'not_found')
  })

  it('fall back to the default term, created once, when an entry has none', async () => {
    const { content } = await site()
    const [a, b] = await Promise.all([content.create('core.post'), content.create('core.post')])
    const terms = await content.entryTerms([a.id, b.id], 'core.category')
    expect(terms.get(a.id)![0]!.id).toBe(terms.get(b.id)![0]!.id)
    expect((await content.listTerms({ taxonomy: 'core.category' })).total).toBe(1)
    const news = await content.createTerm('core.category', { name: 'News' })
    expect(names(await content.setEntryTerms(a.id, 'core.category', { ids: [news.id] }))).toEqual([
      'News',
    ])
    expect(names(await content.setEntryTerms(a.id, 'core.category', { ids: [] }))).toEqual([
      'Uncategorized',
    ])
    // Updating keeps what the entry has.
    await content.update(a.id, { title: 'Again' })
    expect(names((await content.entryTerms([a.id])).get(a.id)!)).toEqual(['Uncategorized'])
  })

  it('filter entry lists, a category including its children, as WordPress queries do', async () => {
    const { content } = await site()
    const news = await content.createTerm('core.category', { name: 'News' })
    const local = await content.createTerm('core.category', { name: 'Local', parentId: news.id })
    const tag = await content.createTerm('core.tag', { name: 'Hot' })
    const inNews = await content.create('core.post', { title: 'In news' })
    const inLocal = await content.create('core.post', { title: 'In local' })
    await content.create('core.post', { title: 'Elsewhere' })
    await content.setEntryTerms(inNews.id, 'core.category', { ids: [news.id] })
    await content.setEntryTerms(inLocal.id, 'core.category', { ids: [local.id] })
    await content.setEntryTerms(inLocal.id, 'core.tag', { ids: [tag.id] })
    const titles = async (terms: object) =>
      (await content.list({ type: 'core.post', terms, orderBy: 'title' })).entries.map(
        (e) => e.title,
      )
    expect(await titles({ 'core.category': [news.id] })).toEqual(['In local', 'In news'])
    expect(await titles({ 'core.category': [local.id] })).toEqual(['In local'])
    expect(await titles({ 'core.category': [news.id], 'core.tag': [tag.id] })).toEqual(['In local'])
    expect(await titles({ 'core.category': ['not-an-id'] })).toEqual([])
  })

  it('load for a page of entries in one go, and go with a deleted entry', async () => {
    const { content } = await site()
    const post = await content.create('core.post')
    await content.setEntryTerms(post.id, 'core.tag', { names: ['b', 'A'] })
    const all = await content.entryTerms([post.id, 'nope'])
    expect(names(all.get(post.id)!)).toEqual(['A', 'b', 'Uncategorized'])
    expect(all.has('nope')).toBe(false)
    await content.delete(post.id)
    expect((await content.listTerms({ taxonomy: 'core.tag' })).counts).toEqual([0, 0])
  })
})

describe('names', () => {
  it('are shared between content types and taxonomies', async () => {
    const clash = plugin('clash', {
      setup(cms) {
        cms.content.type('thing', { labels: { singular: 'Thing', plural: 'Things' } })
        cms.content.taxonomy('thing', {
          labels: { singular: 'Thing', plural: 'Things' },
          types: [],
        })
      },
    })
    await expect(bootKernel({ plugins: [clash] })).rejects.toThrow("has a content type's name")
  })
})
