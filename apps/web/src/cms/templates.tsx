import type { SiteTemplates } from '@otwdesign/next'
import { AccountTemplate } from '@otwdesign/next/site'

/**
 * The site's own templates, as a theme's: the account pages are the CMS's, under a line of the
 * site's. `cms generate` adds this file to the site's module.
 */
const templates: SiteTemplates = {
  account: (props) => (
    <div className="site-account">
      <p className="site-account-kicker">Members’ area</p>
      <AccountTemplate {...props} />
    </div>
  ),
}

export default templates
