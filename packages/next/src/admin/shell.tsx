import { availableUpdates, CORE_VERSION, type Kernel } from '@otwdesign/core'
import type { User } from '@otwdesign/sdk'
import { cookies } from 'next/headers'
import type { ReactNode } from 'react'
import { getKernel } from '../runtime/kernel'
import { getCurrentUser } from '../runtime/session'
import { AdminBar } from './admin-bar'
import { AdminFrame, AdminMenu, SignedOutFrame } from './admin-frame'
import { BrandName } from './brand-mark'
import { MENU_COOKIE, menuPreference } from './admin-menu-preference'
import { updateOverview } from './update-overview'

/** WordPress's admin frame: bar on top, menu on the left, the screen, and the footer. */
async function AdminShell({
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
    <AdminFrame
      preference={menuPreference(jar.get(MENU_COOKIE)?.value)}
      chrome={
        <>
          <a className="screen-reader-shortcut" href="#wpbody-content">
            Skip to main content
          </a>
          <AdminBar
            site={kernel.setting('site.title') ?? 'My Site'}
            user={user}
            logoutUrl={kernel.actionUrl('core', 'logout')}
          />
          <AdminMenu sections={kernel.adminMenu(user)} badges={badges} />
        </>
      }
      footer={
        <footer id="wpfooter">
          <p id="footer-left">
            Thank you for creating with <BrandName brand={kernel.brand} />.
          </p>
          <p id="footer-upgrade">Version {CORE_VERSION}</p>
        </footer>
      }
    >
      {children}
    </AdminFrame>
  )
}

/**
 * The admin's layout: its frame, drawn once per page load. A click between screens then fetches
 * the screen alone, not the bar, the menu and its counts again. It decides only whether to draw
 * the frame; every page still checks who may open it (`requireAdmin`), since a layout isn't run
 * again for each screen under it.
 */
export async function AdminLayout({ children }: { children: ReactNode }) {
  const [kernel, user] = await Promise.all([getKernel(), getCurrentUser()])
  if (!user || !kernel.can(user, 'core.access_admin')) {
    return <SignedOutFrame>{children}</SignedOutFrame>
  }
  return (
    <AdminShell kernel={kernel} user={user}>
      {children}
    </AdminShell>
  )
}
