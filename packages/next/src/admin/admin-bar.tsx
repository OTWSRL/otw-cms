import { AdminIcon } from '@otwdesign/admin-ui'
import type { User } from '@otwdesign/sdk'
import Link from 'next/link'
import { AccountMenu, MenuToggle } from './admin-frame'

/** WordPress's default avatar is a grey silhouette; there are no uploaded avatars yet. */
function Avatar({ size }: { size: 'small' | 'large' }) {
  return (
    <span className={`avatar avatar-${size}`} aria-hidden="true">
      <AdminIcon icon="users" />
    </span>
  )
}

function HomeIcon() {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false">
      <path d="M10 2 1.5 9.6l1.3 1.4L4 10v8h4.5v-5h3v5H16v-8l1.2 1 1.3-1.4Z" fill="currentColor" />
    </svg>
  )
}

/** The black bar along the top (`#wpadminbar`): the site, and the account menu on the right. */
export function AdminBar({
  site,
  user,
  logoutUrl,
}: {
  site: string
  user: User
  logoutUrl: string
}) {
  const name = user.name || user.email.split('@')[0]
  return (
    <header id="wpadminbar">
      <div className="quicklinks">
        <ul className="ab-top-menu">
          <li id="wp-admin-bar-menu-toggle">
            <MenuToggle />
          </li>
          <li id="wp-admin-bar-site-name">
            <Link className="ab-item" href="/">
              <HomeIcon />
              <span className="ab-label">{site}</span>
              <span className="screen-reader-text"> (view site)</span>
            </Link>
          </li>
        </ul>
        <ul className="ab-top-menu ab-top-secondary">
          <AccountMenu
            greeting={
              <>
                <span className="ab-label">Howdy, {name}</span>
                <Avatar size="small" />
              </>
            }
          >
            <ul className="ab-submenu">
              <li id="wp-admin-bar-user-info">
                <Avatar size="large" />
                <span className="display-name">{name}</span>
                <span className="username">{user.email}</span>
              </li>
              <li id="wp-admin-bar-edit-profile">
                <Link className="ab-item" href="/admin/profile">
                  Edit Profile
                </Link>
              </li>
              <li id="wp-admin-bar-logout">
                <form method="post" action={logoutUrl}>
                  <button type="submit" className="ab-item">
                    Log Out
                  </button>
                </form>
              </li>
            </ul>
          </AccountMenu>
        </ul>
      </div>
    </header>
  )
}
