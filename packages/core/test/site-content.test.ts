import type { ContentResolution } from '../src/site-content'
import type { User } from '@otwdesign/sdk'
import { describe, expect, it } from 'vitest'
import type { Kernel } from '../src/kernel'
import { bootKernel, plugin, signIn } from './helpers'

declare module '@otwdesign/sdk' {
  interface ContentTypes {
    'school.course': true
  }
  interface Taxonomies {
    'school.level': true
  }
}

const school = plugin('school', {
  setup(cms) {
    cms.content.type('course', {
      labels: { singular: 'Course', plural: 'Courses' },
      public: true,
      hasArchive: true,
    })
    cms.content.taxonomy('level', {
      labels: { singular: 'Level', plural: 'Levels' },
      types: ['school.course'],
    })
  },
})

async function site(options: Parameters<typeof bootKernel>[0] = { plugins: [school] }) {
  const kernel = await bootKernel(options)
  return { kernel, content: kernel.content }
}

/** What a path shows, in brief: the view, whose, and the entry's title or the list's titles. */
async function at(kernel: Kernel, path: string, user: User | null = null, query = {}) {
  const found = await kernel.resolveContent(path, query, user)
  return found && summary(found)
}

function summary(found: ContentResolution) {
  return found.view === 'single'
    ? `${found.name}: ${found.props.entry.title}${found.props.preview ? ' (preview)' : ''}`
    : `${found.view} ${found.name}: ${found.props.items.map((item) => item.entry.title).join(', ')}`
}

describe('site content', () => {
  it('finds pages by path, then posts by slug, as WordPress does with Post name permalinks', async () => {
    const { kernel, content } = await site()
    const about = await content.create('core.page', { title: 'About', status: 'published' })
    await content.create('core.page', { title: 'Team', parentId: about.id, status: 'published' })
    await content.create('core.post', { title: 'About', status: 'published' })
    await content.create('core.post', { title: 'Hello', status: 'published' })
    await content.create('core.post', { title: 'Draft' })
    expect(await at(kernel, '/about')).toBe('core.page: About')
    expect(await at(kernel, '/about/team')).toBe('core.page: Team')
    expect(await at(kernel, '/hello')).toBe('core.post: Hello')
    expect(await at(kernel, '/team')).toBeNull()
    expect(await at(kernel, '/draft')).toBeNull()
    expect(await at(kernel, '/nothing/here')).toBeNull()
  })

  it('shows private entries only to those who may read them, and drafts only in preview', async () => {
    const { kernel, content } = await site()
    const author = await signIn(kernel, 'author')
    const editor = await signIn(kernel, 'editor')
    await content.create('core.post', { title: 'Secret', status: 'private' })
    const draft = await content.create('core.post', { title: 'Mine', authorId: author.user.id })
    expect(await at(kernel, '/secret')).toBeNull()
    expect(await at(kernel, '/secret', author.user)).toBeNull()
    expect(await at(kernel, '/secret', editor.user)).toBe('core.post: Secret')
    const preview = { preview: draft.id }
    expect(await at(kernel, '/', author.user, preview)).toBe('core.post: Mine (preview)')
    expect(await at(kernel, '/', editor.user, preview)).toBe('core.post: Mine (preview)')
    expect(await at(kernel, '/', null, preview)).toBeNull()
    expect(await at(kernel, '/', author.user, { preview: 'nope' })).toBeNull()
    const found = await kernel.resolveContent('/', preview, author.user)
    expect(found?.metadata.noindex).toBe(true)
  })

  it('lists the latest posts on the home page, a page at a time', async () => {
    const { kernel, content } = await site({
      plugins: [],
      settings: { 'reading.posts_per_page': '2' },
    })
    for (const [title, day] of [
      ['One', 1],
      ['Two', 2],
      ['Three', 3],
    ] as const) {
      await content.create('core.post', {
        title,
        status: 'published',
        publishedAt: new Date(Date.UTC(2026, 0, day)),
      })
    }
    expect(await at(kernel, '/')).toBe('archive core.post: Three, Two')
    const second = await kernel.resolveContent('/', { page: '2' }, null)
    expect(second && summary(second)).toBe('archive core.post: One')
    expect(second?.view !== 'single' && second?.props.pageUrl(1)).toBe('/')
    expect(second?.view !== 'single' && [second?.props.page, second?.props.pages]).toEqual([2, 2])
  })

  it('shows a static homepage and a posts page, as Settings › Reading chooses', async () => {
    const kernel0 = await bootKernel({ plugins: [] })
    const home = await kernel0.content.create('core.page', {
      title: 'Welcome',
      status: 'published',
    })
    const blog = await kernel0.content.create('core.page', { title: 'Blog', status: 'published' })
    await kernel0.content.create('core.post', { title: 'News', status: 'published' })
    const kernel = await bootKernel({
      plugins: [],
      db: kernel0.db,
      settings: {
        'reading.show_on_front': 'page',
        'reading.page_on_front': home.id,
        'reading.page_for_posts': blog.id,
      },
    })
    expect(await at(kernel, '/')).toBe('core.page: Welcome')
    expect(await at(kernel, '/blog')).toBe('archive core.post: News')
    const links = await kernel.content.permalinks([home, blog])
    expect([links.get(home.id), links.get(blog.id)]).toEqual(['/', '/blog'])
    // A homepage that's gone falls back to the latest posts.
    await kernel.content.trash(home.id)
    expect(await at(kernel, '/')).toBe('archive core.post: News')
  })

  it("serves a plugin's type, its archive and its taxonomy's terms", async () => {
    const { kernel, content } = await site()
    const basics = await content.create('school.course', { title: 'Basics', status: 'published' })
    await content.create('school.course', { title: 'Hidden' })
    const beginner = await content.createTerm('school.level', { name: 'Beginner' })
    await content.setEntryTerms(basics.id, 'school.level', { ids: [beginner.id] })
    expect(await at(kernel, '/course/basics')).toBe('school.course: Basics')
    expect(await at(kernel, '/courses')).toBe('archive school.course: Basics')
    expect(await at(kernel, '/level/beginner')).toBe('term school.level: Basics')
    expect(await at(kernel, '/level/expert')).toBeNull()
    expect(content.archiveUrl('school.course')).toBe('/courses')
    expect(content.termUrl(beginner)).toBe('/level/beginner')
    const single = await kernel.resolveContent('/course/basics', {}, null)
    expect(single?.view === 'single' && single.props.terms.map((t) => t.name)).toEqual(['Beginner'])
  })

  it("gives categories' archives their children's posts, as WordPress does", async () => {
    const { kernel, content } = await site({ plugins: [] })
    const news = await content.createTerm('core.category', { name: 'News' })
    const local = await content.createTerm('core.category', { name: 'Local', parentId: news.id })
    const post = await content.create('core.post', { title: 'Fete', status: 'published' })
    await content.setEntryTerms(post.id, 'core.category', { ids: [local.id] })
    expect(await at(kernel, '/category/news')).toBe('term core.category: Fete')
    expect(content.termUrl(local)).toBe('/category/local')
  })

  it('builds permalinks from ancestors, and gives none to drafts or under a draft', async () => {
    const { content } = await site()
    const parent = await content.create('core.page', { title: 'Parent', status: 'published' })
    const child = await content.create('core.page', {
      title: 'Child',
      parentId: parent.id,
      status: 'private',
    })
    const draftParent = await content.create('core.page', { title: 'Later', slug: 'later' })
    const orphan = await content.create('core.page', {
      title: 'Orphan',
      parentId: draftParent.id,
      status: 'published',
    })
    const draft = await content.create('core.post', { title: 'Draft' })
    const course = await content.create('school.course', { title: 'Café', status: 'published' })
    const links = await content.permalinks([parent, child, orphan, draft, course])
    expect(Object.fromEntries(links)).toEqual({
      [parent.id]: '/parent',
      [child.id]: '/parent/child',
      [orphan.id]: null,
      [draft.id]: null,
      [course.id]: '/course/cafe',
    })
    expect(content.previewUrl(draft)).toBe(`/?preview=${draft.id}`)
  })

  it('moves where content lives with the site’s routes, and refuses bad ones', async () => {
    const { kernel, content } = await site({
      plugins: [school],
      routes: {
        'core.post.single': '/blog/:slug',
        'school.course.archive': '/learn',
        'core.category.term': '/topics/:slug',
      },
    })
    const post = await content.create('core.post', { title: 'Hi', status: 'published' })
    await content.create('school.course', { title: 'Art', status: 'published' })
    expect(await at(kernel, '/blog/hi')).toBe('core.post: Hi')
    expect(await at(kernel, '/hi')).toBeNull()
    expect(await at(kernel, '/learn')).toBe('archive school.course: Art')
    expect((await content.permalinks([post])).get(post.id)).toBe('/blog/hi')
    expect(kernel.warnings.some((warning) => warning.includes('routes'))).toBe(false)
    await expect(
      bootKernel({ plugins: [], routes: { 'core.post.single': '/blog/:id' } }),
    ).rejects.toThrow('must be static segments then /:slug')
    await expect(
      bootKernel({ plugins: [], routes: { 'core.post.single': '/admin/:slug' } }),
    ).rejects.toThrow('reserved path')
  })

  it('uses the highest-priority plugin template, registered in setup()', async () => {
    const plain = () => 'plain'
    const fancy = () => 'fancy'
    const themes = plugin('themes', {
      setup(cms) {
        cms.content.template({ view: 'single', for: 'core.post', component: fancy, priority: 20 })
        cms.content.template({ view: 'single', for: 'core.post', component: plain })
      },
    })
    const kernel = await bootKernel({ plugins: [themes] })
    expect(kernel.contentTemplate('single', 'core.post')).toBe(fancy)
    expect(kernel.contentTemplate('archive', 'core.post')).toBeUndefined()
  })
})
