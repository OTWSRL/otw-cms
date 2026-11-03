import type { AdminDefinition, PluginDefinition } from '@otwdesign/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Registry from '../src/site-registry'
import type { Site, SiteTemplates } from '../src/site-registry'

// The registry is module state: each test starts with a fresh copy, as a new server does.
let registry: typeof Registry
const fresh = async () => {
  vi.resetModules()
  registry = await import('../src/site-registry')
}
beforeEach(fresh)

const plugins = [{ id: 'shop' }] as unknown as PluginDefinition[]
const templates: SiteTemplates = { account: () => null }
/** What `cms generate` writes: the site's module, and the admin's with the plugins' admin entries. */
const pagesModule: Site = { plugins, packages: ['@acme/shop'], templates }
const adminModule: Site = {
  plugins,
  packages: ['@acme/shop'],
  admin: [{ id: 'shop' }] as unknown as AdminDefinition[],
}

describe('the registered site', () => {
  it('has the admin’s entries and the site’s templates, whichever module loaded last', async () => {
    // Next shares one copy of the registry between the site's pages and the admin.
    for (const order of [
      [pagesModule, adminModule],
      [adminModule, pagesModule],
    ]) {
      await fresh()
      for (const registration of order) registry.defineSite(registration)
      const site = registry.currentSite()
      expect(site.admin).toBe(adminModule.admin)
      expect(site.templates).toBe(templates)
      expect(site.plugins).toBe(plugins)
    }
  })

  it('is either module alone, where a bundle has only one', () => {
    registry.defineSite(adminModule)
    expect(registry.currentSite()).toBe(adminModule)
  })

  it('stays the same object until a module registers again, as a dev reload does', () => {
    registry.defineSite(pagesModule)
    registry.defineSite(adminModule)
    const site = registry.currentSite()
    expect(registry.currentSite()).toBe(site)

    // A site that drops its templates.tsx, and adds a plugin to cms.config.json.
    const reloaded: Site = { plugins: [...plugins, { id: 'blog' } as unknown as PluginDefinition] }
    registry.defineSite(reloaded)
    const next = registry.currentSite()
    expect(next).not.toBe(site)
    expect(next.templates).toBeUndefined()
    expect(next.plugins).toBe(reloaded.plugins)
    expect(next.admin).toBe(adminModule.admin)
  })

  it('gives pages the templates, imported when a page asks if the module gives them lazily', async () => {
    const load = vi.fn(async () => ({ default: templates }))
    registry.defineSite({ plugins, templates: load })
    expect(load).not.toHaveBeenCalled()
    expect(await registry.siteTemplates()).toBe(templates)

    // A site module written by hand may give them as they are.
    registry.defineSite({ plugins, templates })
    expect(await registry.siteTemplates()).toBe(templates)
    registry.defineSite({ plugins })
    expect(await registry.siteTemplates()).toBeUndefined()
  })

  it('says how to register one when no module has', () => {
    expect(() => registry.currentSite()).toThrow('Import src/cms/site.generated.ts')
  })
})
