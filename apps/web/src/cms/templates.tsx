import type { SiteTemplates } from '@otw/next'
import { AccountTemplate } from '@otw/next/site'

/**
 * The shop's own templates, as a theme's: the account pages are the CMS's, under a line of the
 * shop's. `cms generate` adds this file to the site's module.
 */
const templates: SiteTemplates = {
  account: (props) => (
    <div className="shop-account">
      <p className="shop-account-kicker">Your shop account</p>
      <AccountTemplate {...props} />
    </div>
  ),
}

export default templates
