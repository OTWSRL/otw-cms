import { availableUpdates, CORE_VERSION, type Kernel } from '@otw/core'
import type { User } from '@otw/sdk'
import { cookies } from 'next/headers'
import type { ReactNode } from 'react'
import { AdminBar } from './admin-bar'
import { AdminFrame, AdminMenu } from './admin-frame'
import { BrandName } from './brand-mark'
import { MENU_COOKIE, menuPreference } from './admin-menu-preference'
import { Slot } from '../site/slot'
import { updateOverview } from './update-overview'

/** WordPress's admin frame: bar on top, menu on the left, the screen, and the footer. */
export async function AdminShell({
  kernel,
  user,
  children,
}: {
  kernel: Kernel
  user: User
  children: ReactNode
}) {
  const [jar, overview] = await Promise.all([cookies(), updateOverview(kernel, user)])
  const total = overview ? availableUpdates(overview) : 0
  const plugins =
    overview?.channel === 'serve'
      ? (overview.lastCheck?.plugins.filter((plugin) => plugin.to).length ?? 0)
      : 0
  const badges = { dashboard: total, 'core.updates': total, plugins, 'core.plugins': plugins }
  return (
    <AdminFrame preference={menuPreference(jar.get(MENU_COOKIE)?.value)}>
      <a className="screen-reader-shortcut" href="#wpbody-content">
        Skip to main content
      </a>
      <AdminBar
        site={kernel.setting('site.title') ?? 'My Site'}
        user={user}
        logoutUrl={kernel.actionUrl('core', 'logout')}
      />
      <AdminMenu sections={kernel.adminMenu(user)} badges={badges} />
      <div id="wpcontent">
        <main id="wpbody-content" tabIndex={-1}>
          {children}
        </main>
      </div>
      <footer id="wpfooter">
        <p id="footer-left">
          Thank you for creating with <BrandName brand={kernel.brand} />.
        </p>
        <p id="footer-upgrade">Version {CORE_VERSION}</p>
      </footer>
      <Slot name="admin.footer" props={{ user }} />
    </AdminFrame>
  )
}
