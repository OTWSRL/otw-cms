import { PGlite } from '@electric-sql/pglite'
import { defineAdmin, definePlugin } from '@otw/sdk'
import { drizzle } from 'drizzle-orm/pglite'
import { afterEach, describe, expect, it } from 'vitest'
import { bootSite } from '../src/runtime/boot'

const recipes = definePlugin({
  id: 'recipes',
  version: '1.0.0',
  setup(cms) {
    cms.routes.page({ name: 'recipe', path: '/recipes/:slug', component: () => null })
  },
})

let client: PGlite | undefined
afterEach(() => client?.close())

describe('bootSite', () => {
  it('moves plugin pages to the paths the site gives them', async () => {
    client = new PGlite()
    const site = { plugins: [recipes], routes: { 'recipes.recipe': '/cook/:slug' } }
    const kernel = await bootSite(site, drizzle(client), { env: {} })
    expect(kernel.url('recipes.recipe', { slug: 'soup' })).toBe('/cook/soup')
    expect(await kernel.resolvePage('/cook/soup')).not.toBeNull()
    expect(await kernel.resolvePage('/recipes/soup')).toBeNull()
  })

  it("boots the plugins' admin entries where the site module has them, and only there", async () => {
    const admin = defineAdmin(recipes, (cms) => {
      cms.admin.page({
        name: 'recipes',
        path: '/',
        title: 'Recipes',
        capability: 'core.access_admin',
        component: () => null,
      })
    })
    client = new PGlite()
    const db = drizzle(client)
    const withAdmin = await bootSite({ plugins: [recipes], admin: [admin] }, db, { env: {} })
    expect(withAdmin.adminUrl('recipes.recipes')).toBe('/admin/recipes')
    const storefront = await bootSite({ plugins: [recipes] }, db, { env: {} })
    expect(() => storefront.adminUrl('recipes.recipes')).toThrow('Unknown route')
  })
})
