import type { CapabilityName } from '@cms/sdk'
import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { adminTitle } from '@/components/admin'
import { AdminNavLink } from '@/components/admin-nav-link'
import { getKernel } from '@/cms/kernel'
import { getCurrentUser } from '@/cms/session'
import '../admin.css'
import Link from 'next/link'

const CORE_SCREENS: { href: string; label: string; capability: CapabilityName }[] = [
  { href: '/admin/plugins', label: 'Plugins', capability: 'core.manage_plugins' },
  { href: '/admin/settings', label: 'Settings', capability: 'core.manage_settings' },
  { href: '/admin/users', label: 'Users', capability: 'core.manage_users' },
]

export async function generateMetadata(): Promise<Metadata> {
  const site = (await getKernel()).setting('site.title') ?? 'Next CMS'
  return {
    title: { default: `Admin · ${site}`, template: adminTitle(site) },
    robots: { index: false, follow: false },
  }
}

export default async function PanelLayout({ children }: { children: ReactNode }) {
  const [kernel, user] = await Promise.all([getKernel(), getCurrentUser()])
  // Signed out or no admin access: the page itself redirects or answers 403.
  if (!user || !kernel.can(user, 'core.access_admin')) return children

  const screens = CORE_SCREENS.filter((screen) => kernel.can(user, screen.capability))
  return (
    <div className="cms-admin">
      <aside className="cms-admin-sidebar">
        <Link href="/admin" className="cms-admin-brand">
          {kernel.setting('site.title') ?? 'Next CMS'}
        </Link>
        <nav aria-label="Admin">
          <ul>
            <li>
              <AdminNavLink href="/admin" exact>
                Dashboard
              </AdminNavLink>
            </li>
            {screens.map((screen) => (
              <li key={screen.href}>
                <AdminNavLink href={screen.href}>{screen.label}</AdminNavLink>
              </li>
            ))}
          </ul>
          {kernel.adminMenu(user).map((group) => (
            <section key={group.pluginId} aria-labelledby={`menu-${group.pluginId}`}>
              <h2 id={`menu-${group.pluginId}`}>{group.label}</h2>
              <ul>
                {group.items.map((item) => (
                  <li key={item.key}>
                    <AdminNavLink href={item.url}>{item.label}</AdminNavLink>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </nav>
        <div className="cms-admin-account">
          <span>{user.name || user.email}</span>
          <Link href="/">View site</Link>
          <form method="post" action={kernel.actionUrl('core', 'logout')}>
            <button type="submit" className="cms-link-button">
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <main className="cms-admin-main">{children}</main>
    </div>
  )
}
