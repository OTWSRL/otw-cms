import Link from 'next/link'

/** WordPress's wp_die() box: "Sorry, you are not allowed to access this page." */
export function AdminForbidden() {
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

/** The admin's 404, for paths no core screen or active plugin serves. */
export function AdminNotFound() {
  return (
    <main className="cms-login">
      <div className="cms-die">
        <h1>This admin page doesn&apos;t exist.</h1>
        <p>
          The plugin that adds it may be inactive. <Link href="/admin">Go to the Dashboard</Link>
        </p>
      </div>
    </main>
  )
}
