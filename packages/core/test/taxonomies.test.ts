import type { CapabilityName, MetaCapabilityName, TaxonomyDefinition, Term, User } from '@otw/sdk'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { CapabilityStore } from '../src/capabilities'
import { ContentTypeStore } from '../src/content-types'
import { registerCoreCapabilities, registerCoreContent } from '../src/core-plugin'
import { TaxonomyStore } from '../src/taxonomies'

declare module '@otw/sdk' {
  interface Taxonomies {
    'shelf.genre': true
  }
}

const user = (role: string): User => ({ id: 'u', email: 'u@b.co', name: '', role })

function site(extra: Record<string, TaxonomyDefinition> = {}) {
  let sealed = false
  const assertOpen = (what: string) => {
    if (sealed) throw new Error(`late ${what}`)
  }
  const capabilities = new CapabilityStore(assertOpen, () => {})
  const types = new ContentTypeStore(assertOpen, capabilities)
  const taxonomies = new TaxonomyStore(assertOpen, capabilities)
  registerCoreCapabilities(capabilities)
  const adminPath = (type: string) => types.get(type)?.adminPath
  registerCoreContent({
    register: (pluginId, name, definition) => types.register(pluginId, name, definition),
    taxonomy: (pluginId, name, definition) =>
      taxonomies.register(pluginId, name, definition, adminPath),
  })
  for (const [name, definition] of Object.entries(extra)) {
    taxonomies.register('shelf', name, definition, adminPath)
  }
  capabilities.seal()
  sealed = true
  return { capabilities, taxonomies }
}

const term = (taxonomy: string, slug = 'news'): Term => ({
  id: '00000000-0000-4000-8000-000000000001',
  taxonomy,
  name: slug,
  slug,
  description: '',
  parentId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
})

describe('taxonomies', () => {
  it("are WordPress's categories and tags in core, with WordPress's capability names", () => {
    const { taxonomies } = site()
    expect(taxonomies.get('core.category')).toMatchObject({
      hierarchical: true,
      showAdminColumn: true,
      types: ['core.post'],
      defaultTerm: { name: 'Uncategorized', slug: 'uncategorized' },
      adminPath: '/admin/posts/categories',
      capabilities: {
        manage: 'core.manage_categories',
        edit: 'core.edit_categories',
        delete: 'core.delete_categories',
        assign: 'core.assign_categories',
        editTerm: 'core.edit_category',
        deleteTerm: 'core.delete_category',
        assignTerm: 'core.assign_category',
      },
    })
    expect(taxonomies.get('core.tag')).toMatchObject({
      hierarchical: false,
      defaultTerm: null,
      adminPath: '/admin/posts/tags',
    })
    expect(taxonomies.list('core.post').map((t) => t.name)).toEqual(['core.category', 'core.tag'])
    expect(taxonomies.list('core.page')).toEqual([])
    expectTypeOf<'core.manage_categories'>().toExtend<CapabilityName>()
    expectTypeOf<'shelf.assign_genres'>().toExtend<CapabilityName>()
    expectTypeOf<'core.delete_tag'>().toExtend<MetaCapabilityName>()
  })

  it('let editors manage terms, and authors and contributors only assign them', () => {
    const { capabilities } = site()
    const can = (role: string, capability: string) =>
      capabilities.can(user(role), capability as CapabilityName)
    expect(
      ['manage', 'edit', 'delete', 'assign'].map((v) => can('editor', `core.${v}_categories`)),
    ).toEqual([true, true, true, true])
    for (const role of ['author', 'contributor']) {
      expect(can(role, 'core.manage_categories')).toBe(false)
      expect(can(role, 'core.assign_categories')).toBe(true)
      expect(can(role, 'core.assign_tags')).toBe(true)
    }
    expect(can('customer', 'core.assign_tags')).toBe(false)
  })

  it("map term capabilities as WordPress does: the default term can't be deleted", () => {
    const { capabilities } = site()
    const check = capabilities.can.bind(capabilities) as (u: User, c: string, t: Term) => boolean
    const admin = user('administrator')
    expect(check(admin, 'core.delete_category', term('core.category'))).toBe(true)
    expect(check(admin, 'core.delete_category', term('core.category', 'uncategorized'))).toBe(false)
    expect(check(admin, 'core.edit_category', term('core.category', 'uncategorized'))).toBe(true)
    expect(check(admin, 'core.edit_category', term('core.tag'))).toBe(false)
    expect(check(user('author'), 'core.assign_tag', term('core.tag'))).toBe(true)
    expect(check(user('author'), 'core.edit_tag', term('core.tag'))).toBe(false)
  })

  it('have no screen without a type that has screens', () => {
    const { taxonomies } = site({
      genre: { labels: { singular: 'Genre', plural: 'Genres' }, types: ['shelf.book' as never] },
    })
    expect(taxonomies.get('shelf.genre')?.adminPath).toBeNull()
  })

  it.each([
    ['Genre', {}, 'Invalid taxonomy name'],
    ['genre', { plural: 'genre' }, 'Invalid plural'],
    ['genre', { labels: { singular: 'Genre', plural: '' } }, 'needs labels'],
    ['genre', { types: 'core.post' }, 'needs the content types'],
    ['genre', { roles: { editor: 'boss' } }, 'unknown level "boss"'],
    ['genre', { defaultTerm: { name: '!!!' } }, 'needs a name for its default term'],
  ])('refuse %j with %j', (name, extra, message) => {
    const definition = {
      labels: { singular: 'Genre', plural: 'Genres' },
      types: ['core.post'],
      ...extra,
    } as TaxonomyDefinition
    expect(() => site({ [name]: definition })).toThrow(message)
  })
})
