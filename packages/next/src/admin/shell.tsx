import { CORE_VERSION, type Kernel } from '@cms/core'
import type { User } from '@cms/sdk'
import { cookies } from 'next/headers'
import type { ReactNode } from 'react'
import { AdminBar } from './admin-bar'
import { AdminFrame, AdminMenu } from './admin-frame'
import { MENU_COOKIE, menuPreference } from './admin-menu-preference'

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
  const jar = await cookies()
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
