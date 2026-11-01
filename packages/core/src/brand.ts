/**
 * The name the CMS goes by in the admin: the footer, the Dashboard, Updates and the sign-in screen.
 * A site sets its own in `cms.config.json` to sell the CMS under another name; the code's own
 * names (packages, the `cms` command, tables) stay the same.
 */
export interface Brand {
  name: string
  /** Where the name links, as WordPress links to wordpress.org. */
  url?: string
  /** Shown on the sign-in screen in place of the CMS's mark: a path on the site, or an https URL. */
  logo?: string
}

export const DEFAULT_BRAND: Brand = { name: 'OTW CMS' }
