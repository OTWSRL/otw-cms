import { PGlite } from '@electric-sql/pglite'
import { definePlugin } from '@otw/sdk'
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
})
