import type { Brand } from '@otw/core'
import type { PluginDefinition } from '@otw/sdk'

/** What a site gives the CMS. `cms generate` writes it to `src/cms/site.generated.ts`. */
export interface Site {
  /** The installed plugins, in `cms.config.json` order. */
  plugins: readonly PluginDefinition[]
  /** Each plugin's npm package, in the same order, for matching update checks to plugins. */
  packages?: readonly string[]
  /** New paths for plugin pages, by qualified name, from `cms.config.json`. */
  routes?: Readonly<Record<string, string>>
  /** The name the admin shows for the CMS, from `cms.config.json`. */
  brand?: Brand
}

// Module-scoped, not global: Next compiles server components and route handlers separately, and
// each must boot plugins compiled for its own bundle. Each bundle's routes import the site module,
// which registers it here.
let registered: Site | undefined

/** Registers the site for this bundle and returns it. Called by the generated site module. */
export function defineSite(site: Site): Site {
  registered = site
  return site
}

export function currentSite(): Site {
  if (!registered) {
    throw new Error(
      'No site is registered. Import src/cms/site.generated.ts (written by `cms generate`) in this route or its layout.',
    )
  }
  return registered
}
