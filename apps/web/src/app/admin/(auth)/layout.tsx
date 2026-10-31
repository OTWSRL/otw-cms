import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import '../admin.css'

export const metadata: Metadata = { robots: { index: false, follow: false } }

/** wp-login.php's frame: a narrow column centred on grey. */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="cms-login">
      <div id="login">{children}</div>
    </main>
  )
}
