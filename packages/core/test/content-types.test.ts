import type {
  CapabilityArgs,
  CapabilityName,
  ContentTypeDefinition,
  Entry,
  EntryStatus,
  MetaCapabilityName,
  User,
} from '@otw/sdk'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { CapabilityStore } from '../src/capabilities'
import { ContentTypeStore } from '../src/content-types'
import { registerCoreCapabilities, registerCoreContent } from '../src/core-plugin'

declare module '@otw/sdk' {
  interface ContentTypes {
    'shelf.book': true
    'crew.person': { plural: 'people' }
  }
}

const user = (role: string, id: string): User => ({ id, email: `${id}@b.co`, name: '', role })

/** Core's roles and types, sealed, with the given plugin types and anything `extra` adds. */
function site(
  types: Record<string, ContentTypeDefinition> = {},
  extra: (capabilities: CapabilityStore) => void = () => {},
) {
  let sealed = false
  const errors: unknown[] = []
  const assertOpen = (what: string) => {
    if (sealed) throw new Error(`late ${what}`)
  }
  const capabilities = new CapabilityStore(assertOpen, (_c, _p, error) => errors.push(error))
  const content = new ContentTypeStore(assertOpen, capabilities)
  registerCoreCapabilities(capabilities)
  registerCoreContent(content)
  for (const [name, definition] of Object.entries(types)) {
    content.register('shelf', name, definition)
  }
  extra(capabilities)
  capabilities.seal()
  sealed = true
  return { capabilities, content, errors }
}

function entry(type: string, status: EntryStatus, authorId: string | null): Entry {
  const trashed = status.startsWith('trash')
  const [, from] = status.split(':') as [string, Entry['trashedFrom']]
  return {
    id: '00000000-0000-4000-8000-000000000001',
    type,
    status: trashed ? 'trash' : status,
    slug: '',
    title: '',
    body: [],
    excerpt: '',
    authorId,
    parentId: null,
    position: 0,
    publishedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    trashedFrom: trashed ? from : null,
    trashedAt: trashed ? new Date() : null,
    meta: {},
  }
}

const AUTHOR = 'a'
const OTHER = 'b'

describe('content type capabilities', () => {
  it("are named as WordPress's, under the plugin's id", () => {
    const { content } = site({ book: { labels: { singular: 'Book', plural: 'Books' } } })
    expect(content.get('shelf.book')?.capabilities).toEqual({
      edit: 'shelf.edit_books',
      editOthers: 'shelf.edit_others_books',
      editPublished: 'shelf.edit_published_books',
      editPrivate: 'shelf.edit_private_books',
      publish: 'shelf.publish_books',
      readPrivate: 'shelf.read_private_books',
      delete: 'shelf.delete_books',
      deleteOthers: 'shelf.delete_others_books',
      deletePublished: 'shelf.delete_published_books',
      deletePrivate: 'shelf.delete_private_books',
      editEntry: 'shelf.edit_book',
      readEntry: 'shelf.read_book',
      deleteEntry: 'shelf.delete_book',
      publishEntry: 'shelf.publish_book',
    })
  })

  it('take a plural for names that need one, and type-check from ContentTypes', () => {
    const { content } = site({
      person: { labels: { singular: 'Person', plural: 'People' }, plural: 'people' },
    })
    expect(content.get('shelf.person')?.capabilities.editOthers).toBe('shelf.edit_others_people')
    expect(content.get('shelf.person')?.capabilities.editEntry).toBe('shelf.edit_person')

    expectTypeOf<'shelf.edit_others_books'>().toExtend<CapabilityName>()
    expectTypeOf<'crew.delete_private_people'>().toExtend<CapabilityName>()
    expectTypeOf<'core.publish_pages'>().toExtend<CapabilityName>()
    expectTypeOf<'shelf.edit_book'>().toExtend<MetaCapabilityName>()
    expectTypeOf<CapabilityArgs<'core.edit_post'>>().toEqualTypeOf<[entry: Entry]>()
    expectTypeOf<CapabilityArgs<'core.edit_posts'>>().toEqualTypeOf<[]>()
    expectTypeOf<'crew.edit_persons'>().not.toExtend<CapabilityName>()
  })

  it('list on the Roles screen with readable labels', () => {
    const { capabilities } = site({
      faq: { labels: { singular: 'FAQ', plural: 'FAQs' }, roles: { editor: 'editor' } },
    })
    const labels = new Map(capabilities.capabilities().map((c) => [c.name, c.label]))
    expect(labels.get('core.edit_others_posts')).toBe("Edit others' posts")
    expect(labels.get('shelf.edit_faqs')).toBe('Edit their own FAQs')
  })
})

describe("roles' levels over a type, as WordPress's roles over posts", () => {
  const { capabilities } = site()
  const has = (role: string) =>
    capabilities
      .roles()
      .find((info) => info.id === role)!
      .capabilities.filter((name) => name.startsWith('core.') && name.endsWith('_posts'))

  it('editors have every post capability; authors their own, publishing included; contributors drafts', () => {
    expect(has('editor')).toHaveLength(10)
    expect(has('author')).toEqual([
      'core.edit_posts',
      'core.edit_published_posts',
      'core.publish_posts',
      'core.delete_posts',
      'core.delete_published_posts',
    ])
    expect(has('contributor')).toEqual(['core.edit_posts', 'core.delete_posts'])
    expect(has('customer')).toEqual([])
  })

  it('give pages to editors only, as WordPress does', () => {
    const pages = (role: string) =>
      capabilities
        .roles()
        .find((info) => info.id === role)!
        .capabilities.filter((name) => name.endsWith('_pages'))
    expect(pages('editor')).toHaveLength(10)
    expect(pages('author')).toEqual([])
    expect(pages('contributor')).toEqual([])
  })

  it('let every role read, until core.read is revoked', () => {
    expect(capabilities.can(user('customer', OTHER), 'core.read')).toBe(true)
    expect(capabilities.roles().find((role) => role.id === 'customer')?.capabilities).toEqual([
      'core.read',
    ])
  })
})

/** WordPress's map_meta_cap, case by case: [capability, status, author, role, allowed]. */
const CASES: [string, string, string | null, string, boolean][] = [
  // edit_post: one's own drafts need edit_posts; once published, edit_published_posts.
  ['core.edit_post', 'draft', AUTHOR, 'contributor', true],
  ['core.edit_post', 'pending', AUTHOR, 'contributor', true],
  ['core.edit_post', 'published', AUTHOR, 'contributor', false],
  ['core.edit_post', 'published', AUTHOR, 'author', true],
  ['core.edit_post', 'private', AUTHOR, 'contributor', true],
  // Anyone else's need edit_others_posts, and edit_published or edit_private for those.
  ['core.edit_post', 'draft', OTHER, 'author', false],
  ['core.edit_post', 'draft', OTHER, 'editor', true],
  ['core.edit_post', 'published', OTHER, 'editor', true],
  ['core.edit_post', 'private', OTHER, 'editor', true],
  ['core.edit_post', 'draft', null, 'contributor', false],
  ['core.edit_post', 'draft', null, 'editor', true],
  // In the trash, the status it had decides.
  ['core.edit_post', 'trash:published', AUTHOR, 'contributor', false],
  ['core.edit_post', 'trash:published', AUTHOR, 'author', true],
  ['core.edit_post', 'trash:draft', AUTHOR, 'contributor', true],
  // delete_post mirrors edit_post with the delete capabilities.
  ['core.delete_post', 'draft', AUTHOR, 'contributor', true],
  ['core.delete_post', 'published', AUTHOR, 'contributor', false],
  ['core.delete_post', 'published', AUTHOR, 'author', true],
  ['core.delete_post', 'published', OTHER, 'author', false],
  ['core.delete_post', 'private', OTHER, 'editor', true],
  // read_post: published entries and one's own need only read; private ones read_private.
  ['core.read_post', 'published', OTHER, 'customer', true],
  ['core.read_post', 'draft', AUTHOR, 'customer', true],
  ['core.read_post', 'draft', OTHER, 'customer', false],
  ['core.read_post', 'private', OTHER, 'author', false],
  ['core.read_post', 'private', OTHER, 'editor', true],
  ['core.read_post', 'pending', OTHER, 'editor', true],
  // publish_post: publish_posts, whoever wrote it.
  ['core.publish_post', 'draft', AUTHOR, 'contributor', false],
  ['core.publish_post', 'pending', OTHER, 'author', true],
  // Pages are editors'.
  ['core.edit_page', 'draft', AUTHOR, 'author', false],
  ['core.edit_page', 'published', OTHER, 'editor', true],
]

describe('meta capabilities', () => {
  const { capabilities } = site()

  it.each(CASES)(
    '%s on a %s entry by %s: %s → %s',
    (capability, status, authorId, role, allowed) => {
      const type = capability.endsWith('_page') ? 'core.page' : 'core.post'
      const check = capabilities.can.bind(capabilities) as (u: User, c: string, e: Entry) => boolean
      expect(
        check(user(role, AUTHOR), capability, entry(type, status as EntryStatus, authorId)),
      ).toBe(allowed)
    },
  )

  it("check another's trashed entry by the status it had, unlike WordPress", () => {
    // May edit others' drafts, not published posts. WordPress would let this role edit a
    // published post once it's in the trash, since it asks only edit_others_posts there.
    const reviewer = site({}, (store) =>
      store.role('shelf', 'reviewer', {
        label: 'Reviewer',
        capabilities: ['core.edit_posts', 'core.edit_others_posts'],
      }),
    ).capabilities
    const check = (status: string) =>
      reviewer.can(
        user('reviewer', AUTHOR),
        'core.edit_post',
        entry('core.post', status as EntryStatus, OTHER),
      )
    expect(check('draft')).toBe(true)
    expect(check('published')).toBe(false)
    expect(check('trash:published')).toBe(false)
    expect(check('trash:draft')).toBe(true)
  })

  it("refuse an entry of another type, even an administrator's check", () => {
    const page = entry('core.page', 'draft', AUTHOR)
    expect(capabilities.can(user('administrator', AUTHOR), 'core.edit_post', page)).toBe(false)
    expect(capabilities.can(user('administrator', AUTHOR), 'core.edit_page', page)).toBe(true)
  })

  it('give nothing to the signed out', () => {
    expect(capabilities.can(null, 'core.read_post', entry('core.post', 'published', OTHER))).toBe(
      false,
    )
  })
})

describe('registering a type', () => {
  const books = { labels: { singular: 'Book', plural: 'Books' } }

  it('gives plugin types the roles posts have, unless they name their own', () => {
    const { capabilities } = site({
      book: books,
      album: { ...books, roles: { author: 'contributor' } },
    })
    const can = (role: string, capability: CapabilityName) =>
      capabilities.can(user(role, AUTHOR), capability)
    expect(can('author', 'shelf.publish_books')).toBe(true)
    expect(can('contributor', 'shelf.edit_books')).toBe(true)
    expect(can('author', 'shelf.publish_albums' as CapabilityName)).toBe(false)
    expect(can('author', 'shelf.edit_albums' as CapabilityName)).toBe(true)
    expect(can('editor', 'shelf.edit_albums' as CapabilityName)).toBe(false)
  })

  it.each([
    ['Book', books, 'Invalid content type name "Book"'],
    ['book', { ...books, plural: 'book' }, 'Invalid plural "book"'],
    [
      'book',
      { labels: { singular: 'Book', plural: ' ' } },
      'needs labels.singular and labels.plural',
    ],
    ['book', { ...books, supports: ['comments'] }, 'supports unknown features: comments'],
    ['book', { ...books, roles: { editor: 'owner' } }, 'unknown level "owner"'],
    ['book', { ...books, roles: { administrator: 'editor' } }, 'Administrators always have'],
  ])('refuses %j with %j', (name, definition, message) => {
    expect(() => site({ [name]: definition as ContentTypeDefinition })).toThrow(message)
  })

  it('refuses a second type of the same name, and late registrations', () => {
    const { content } = site({ book: books })
    expect(() => content.register('shelf', 'book', books)).toThrow('late content type "shelf.book"')
    const capabilities = new CapabilityStore(
      () => {},
      () => {},
    )
    const open = new ContentTypeStore(() => {}, capabilities)
    open.register('shelf', 'book', books)
    expect(() => open.register('shelf', 'book', books)).toThrow(
      'Content type "shelf.book" is already registered',
    )
  })
})
