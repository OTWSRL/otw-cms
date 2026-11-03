import { FormButton, Notice } from '@otwdesign/admin-ui'
import type { Flash, Kernel } from '@otwdesign/core'
import type { AdminTitleAction } from '@otwdesign/sdk'
import type { ReactNode } from 'react'
import { getKernel } from '../runtime/kernel'
import { getCurrentUser } from '../runtime/session'
import { Slot } from '../site/slot'

/** `Plugins · Admin · My Site`; without a page, the template for one. */
export function adminTitle(site: string, page = '%s'): string {
  return `${page} · Admin · ${site}`
}

/** What plugins want every admin user to see, like WordPress's `admin_notices`. */
async function AdminNotices() {
  const [kernel, user] = await Promise.all([getKernel(), getCurrentUser()])
  if (!user) return null
  const waiting = kernel.databaseUpdates
  return (
    <>
      {waiting.length > 0 && kernel.can(user, 'core.manage_plugins') && (
        // WooCommerce's notice after an update, for sites that migrate at deploy.
        <Notice type="warning" title="Database update required">
          <p>
            {listNames(waiting.map((id) => pluginName(kernel, id)))}{' '}
            {waiting.length === 1 ? 'needs its' : 'need their'} database updated before{' '}
            {waiting.length === 1 ? 'it' : 'they'} can run. Take a backup first.
          </p>
          <FormButton action={kernel.actionUrl('core', 'update-database')} variant="primary">
            Update database
          </FormButton>
        </Notice>
      )}
      <Slot name="admin.notices" props={{ user }} />
    </>
  )
}

function pluginName(kernel: Kernel, id: string): string {
  return kernel.plugins().find((plugin) => plugin.id === id)?.name ?? id
}

function listNames(names: readonly string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
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
