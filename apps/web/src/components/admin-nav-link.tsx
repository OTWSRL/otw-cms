'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'

/** Marks the link to the current screen (or its parent, for edit pages) for assistive tech. */
export function AdminNavLink({
  href,
  exact = false,
  children,
}: {
  href: string
  exact?: boolean
  children: ReactNode
}) {
  const pathname = usePathname()
  const current = exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`)
  return (
    <Link href={href} aria-current={current ? 'page' : undefined}>
      {children}
    </Link>
  )
}
