import Link from 'next/link'
import './admin/admin.css'

/** WordPress's wp_die() box: "Sorry, you are not allowed to access this page." */
export default function Forbidden() {
  return (
    <main className="cms-login">
      <div className="cms-die">
        <h1>Sorry, you are not allowed to access this page.</h1>
        <p>
          Ask an administrator for a role that includes it, or{' '}
          <Link href="/admin/login">log in</Link> as someone else.
        </p>
      </div>
    </main>
  )
}
