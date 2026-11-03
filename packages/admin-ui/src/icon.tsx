import type { AdminIcon as AdminIconValue } from '@otwdesign/sdk'
import { ICONS } from './icon-paths'

/**
 * A menu or screen icon in the current text colour. Data URIs are drawn as a mask over that
 * colour, so a plugin's SVG matches the menu around it, as WordPress tints them.
 */
export function AdminIcon({ icon, className }: { icon: AdminIconValue; className?: string }) {
  if (icon.startsWith('data:')) {
    // isAdminIcon() allows only base64 data URIs, which cannot close the CSS string.
    const mask = `url("${icon}") center / contain no-repeat`
    return (
      <span
        className={className}
        aria-hidden="true"
        style={{ display: 'inline-block', background: 'currentColor', mask, WebkitMask: mask }}
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
