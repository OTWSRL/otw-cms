import type { ReactNode } from 'react'

/** wp-login.php's frame: a narrow column centred on grey. */
export function LoginShell({ children }: { children: ReactNode }) {
  return (
    <main className="cms-login">
      <div id="login">{children}</div>
    </main>
  )
}
