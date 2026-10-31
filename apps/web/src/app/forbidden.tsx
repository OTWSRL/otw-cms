import Link from 'next/link'

export default function Forbidden() {
  return (
    <main className="site-main">
      <h1>You don&apos;t have access to this page</h1>
      <p>
        Ask an administrator for a role that includes it, or{' '}
        <Link href="/admin/login">sign in</Link> as someone else.
      </p>
    </main>
  )
}
