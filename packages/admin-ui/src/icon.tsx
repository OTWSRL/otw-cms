import type { AdminIcon as AdminIconValue } from '@otwdesign/sdk'
import type { CSSProperties } from 'react'
import { cx } from './button'
import { ICONS } from './icon-paths'

/** An icon by name, a base64 SVG data URI, or the address core serves a plugin's icon from. */
export type AdminIconSource = AdminIconValue | `/${string}`

// isAdminIcon() allows only base64 data URIs; an address may hold nothing that could close the
// CSS string or reach another site.
const DRAWN = /^(?:data:image\/svg\+xml;base64,[A-Za-z0-9+/]+={0,2}|\/(?!\/)[\w\-./?=&%]*)$/

/**
 * A menu or screen icon in the current text colour. A data URI or an address is drawn as a mask
 * over that colour, so a plugin's SVG matches the menu around it, as WordPress tints them. The
 * stylesheet's `.cms-icon` holds the mask, so the page carries the image's address only once.
 */
export function AdminIcon({ icon, className }: { icon: AdminIconSource; className?: string }) {
  if (DRAWN.test(icon)) {
    return (
      <span
        className={cx('cms-icon', className)}
        aria-hidden="true"
        style={{ '--cms-icon': `url("${icon}")` } as CSSProperties}
      />
    )
  }
  const { d, holes } = ICONS[icon as keyof typeof ICONS] ?? ICONS.admin
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      width="20"
      height="20"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d={d} fillRule={holes ? 'evenodd' : undefined} />
    </svg>
  )
}
