import type { Metadata } from 'next'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { adminTitle } from '@/components/admin'
import { AdminNav } from '@/components/admin-nav'
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

export default async function PanelLayout({ children }: { children: ReactNode }) {
  const [kernel, user] = await Promise.all([getKernel(), getCurrentUser()])
  // Signed out or no admin access: the page itself redirects or answers 403.
  if (!user || !kernel.can(user, 'core.access_admin')) return children

  return (
    <div className="cms-admin">
      <aside className="cms-admin-sidebar">
        <Link href="/admin" className="cms-admin-brand">
          {kernel.setting('site.title') ?? 'Next CMS'}
        </Link>
        <AdminNav sections={kernel.adminMenu(user)} />
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
