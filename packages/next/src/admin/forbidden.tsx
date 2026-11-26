import { AdminLink } from './admin-link'
import { DieBox } from './die-box'

/** WordPress's wp_die() box: "Sorry, you are not allowed to access this page." */
export function AdminForbidden() {
  return (
    <DieBox>
      <h1>Sorry, you are not allowed to access this page.</h1>
      <p>
        Ask an administrator for a role that includes it, or{' '}
        <AdminLink href="/admin/login">log in</AdminLink> as someone else.
      </p>
    </DieBox>
  )
}

/** The admin's 404, for paths no core screen or active plugin serves. */
export function AdminNotFound() {
  return (
    <DieBox>
      <h1>This admin page doesn&apos;t exist.</h1>
      <p>
        The plugin that adds it may be inactive.{' '}
        <AdminLink href="/admin">Go to the Dashboard</AdminLink>
      </p>
    </DieBox>
  )
}
