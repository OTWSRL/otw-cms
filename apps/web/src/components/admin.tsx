import { Notice } from '@cms/admin-ui'
import type { Flash } from '@cms/core'
import type { AdminTitleAction } from '@cms/sdk'
import type { ReactNode } from 'react'
import { getCurrentUser } from '@/cms/session'
import { Slot } from './slot'

/** `Plugins · Admin · My Site`; without a page, the template for one. */
export function adminTitle(site: string, page = '%s'): string {
  return `${page} · Admin · ${site}`
}

/** What plugins want every admin user to see, like WordPress's `admin_notices`. */
async function AdminNotices() {
  const user = await getCurrentUser()
  return user && <Slot name="admin.notices" props={{ user }} />
}

/** The one-time message after a form post, such as "Settings saved." */
export function FlashNotice({ flash }: { flash: Flash | null }) {
  if (!flash) return null
  const error = flash.kind === 'error'
  return (
    <Notice type={error ? 'error' : 'success'} role={error ? 'alert' : 'status'} dismissible>
      {flash.message}
    </Notice>
  )
}

/**
 * Every admin screen's `.wrap`: the title, an optional "Add New"-style button beside it, then
 * plugin notices and the one-time message, as WordPress prints them under the heading.
 */
export function AdminScreen({
  title,
  titleAction,
  flash,
  children,
}: {
  title: string
  titleAction?: AdminTitleAction | null
  flash: Flash | null
  children: ReactNode
}) {
  return (
    <div className="wrap">
      <h1 className="wp-heading-inline">{title}</h1>
      {titleAction && (
        <a href={titleAction.url} className="page-title-action">
          {titleAction.label}
        </a>
      )}
      <hr className="wp-header-end" />
      <AdminNotices />
      <FlashNotice flash={flash} />
      {children}
    </div>
  )
}
