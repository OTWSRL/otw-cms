import type { ReactNode } from 'react'
import { cx } from './button'
import { DismissButton } from './dismiss-button'

export type NoticeType = 'info' | 'success' | 'warning' | 'error'

/**
 * A notice, as printed on `admin_notices`. Text children are wrapped in a paragraph; pass
 * elements to lay out more.
 */
export function Notice({
  type = 'info',
  title,
  role,
  inline = false,
  dismissible = false,
  children,
}: {
  type?: NoticeType
  title?: ReactNode
  /** `status` or `alert` when the notice reports what just happened. */
  role?: 'status' | 'alert'
  /** Inside a box or form rather than at the top of the screen. */
  inline?: boolean
  /** Adds the × that hides it (`is-dismissible`). */
  dismissible?: boolean
  children?: ReactNode
}) {
  return (
    <div
      className={cx(
        'notice',
        `notice-${type}`,
        inline && 'inline',
        dismissible && 'is-dismissible',
      )}
      role={role}
    >
      {title && (
        <p>
          <strong>{title}</strong>
        </p>
      )}
      {typeof children === 'string' ? <p>{children}</p> : children}
      {dismissible && <DismissButton />}
    </div>
  )
}

/** A meta box: a titled white box, as on the dashboard and edit screens (`add_meta_box`). */
export function Postbox({
  id,
  title,
  actions,
  children,
}: {
  /** Unique on the screen; labels the box for assistive technology. */
  id: string
  title: ReactNode
  /** Small controls on the right of the title bar. */
  actions?: ReactNode
  children: ReactNode
}) {
  const heading = `${id}-title`
  return (
    <section className="postbox" id={id} aria-labelledby={heading}>
      <div className="postbox-header">
        <h2 className="hndle" id={heading}>
          {title}
        </h2>
        {actions && <div className="postbox-actions">{actions}</div>}
      </div>
      <div className="inside">{children}</div>
    </section>
  )
}

/**
 * An edit screen's two columns, as `#poststuff` lays them out: the main boxes, and a 280px
 * sidebar for status and actions. Below 851px they stack, main first.
 */
export function EditColumns({ main, side }: { main: ReactNode; side: ReactNode }) {
  return (
    <div className="edit-columns">
      <div className="edit-columns-main">{main}</div>
      <div className="edit-columns-side">{side}</div>
    </div>
  )
}
