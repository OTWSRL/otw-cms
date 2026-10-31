import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import '../admin.css'

export const metadata: Metadata = { robots: { index: false, follow: false } }

export default function AuthLayout({ children }: { children: ReactNode }) {
  return <main className="cms-auth">{children}</main>
}
