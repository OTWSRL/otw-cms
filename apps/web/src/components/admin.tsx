import type { Flash } from '@cms/core'
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

/** The heading, plugin notices and one-time message every admin screen starts with. */
export function AdminScreen({
  title,
  flash,
  children,
}: {
  title: string
  flash: Flash | null
  children: ReactNode
}) {
  return (
    <>
      <h1>{title}</h1>
      <AdminNotices />
      {flash && (
        <p
          role={flash.kind === 'error' ? 'alert' : 'status'}
          className={`cms-flash cms-flash-${flash.kind}`}
        >
          {flash.message}
        </p>
      )}
      {children}
    </>
  )
}
