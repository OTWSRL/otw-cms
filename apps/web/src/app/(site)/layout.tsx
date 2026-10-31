import Link from 'next/link'
import type { ReactNode } from 'react'
import { Slot } from '@/components/slot'
import { getKernel } from '@/cms/kernel'
import { getCurrentUser } from '@/cms/session'

export default async function SiteLayout({ children }: { children: ReactNode }) {
  const [kernel, user] = await Promise.all([getKernel(), getCurrentUser()])
  return (
    <>
      <header className="site-header">
        <Link href="/" className="site-title">
          {kernel.setting('site.title') ?? 'Next CMS'}
        </Link>
        <nav aria-label="Main">
          <Slot name="header.nav" />
          {kernel.can(user, 'core.access_admin') && <Link href="/admin">Admin</Link>}
        </nav>
      </header>
      <main className="site-main">{children}</main>
    </>
  )
}
