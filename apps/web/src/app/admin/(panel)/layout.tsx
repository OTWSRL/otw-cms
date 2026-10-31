import { CORE_VERSION } from '@cms/core'
import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import type { ReactNode } from 'react'
import { adminTitle } from '@/components/admin'
import { AdminBar } from '@/components/admin-bar'
import { AdminFrame, AdminMenu } from '@/components/admin-frame'
import { MENU_COOKIE, menuPreference } from '@/components/admin-menu-preference'
import { getKernel } from '@/cms/kernel'
import { getCurrentUser } from '@/cms/session'
import '../admin.css'

export async function generateMetadata(): Promise<Metadata> {
  const site = (await getKernel()).setting('site.title') ?? 'Next CMS'
  return {
    title: { default: `Admin · ${site}`, template: adminTitle(site) },
    robots: { index: false, follow: false },
  }
}

/** WordPress's admin frame: bar on top, menu on the left, the screen, and the footer. */
export default async function PanelLayout({ children }: { children: ReactNode }) {
  const [kernel, user, jar] = await Promise.all([getKernel(), getCurrentUser(), cookies()])
  // Signed out or no admin access: the page itself redirects or answers 403.
  if (!user || !kernel.can(user, 'core.access_admin')) return children

  return (
    <AdminFrame preference={menuPreference(jar.get(MENU_COOKIE)?.value)}>
      <a className="screen-reader-shortcut" href="#wpbody-content">
        Skip to main content
      </a>
      <AdminBar
        site={kernel.setting('site.title') ?? 'Next CMS'}
        user={user}
        logoutUrl={kernel.actionUrl('core', 'logout')}
      />
      <AdminMenu sections={kernel.adminMenu(user)} />
      <div id="wpcontent">
        <main id="wpbody-content" tabIndex={-1}>
          {children}
        </main>
      </div>
      <footer id="wpfooter">
        <p id="footer-left">Thank you for creating with Next CMS.</p>
        <p id="footer-upgrade">Version {CORE_VERSION}</p>
      </footer>
    </AdminFrame>
  )
}
