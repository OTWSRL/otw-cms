/** Icons the admin ships, like WordPress's Dashicons. */
export const ADMIN_ICON_NAMES = [
  'admin',
  'dashboard',
  'plugins',
  'users',
  'settings',
  'cart',
  'products',
  'payments',
  'chart',
  'book',
  'groups',
  'media',
  'page',
  'tools',
  'megaphone',
  'calendar',
] as const

/** One of the admin's built-in menu icons. */
export type AdminIconName = (typeof ADMIN_ICON_NAMES)[number]

/**
 * A plugin's menu icon: a built-in name, or a base64 SVG data URI that the admin tints to match
 * the menu, as `add_menu_page()` accepts. The SVG is drawn as a mask, so only its shape counts.
 */
export type AdminIcon = AdminIconName | `data:image/svg+xml;base64,${string}`

const SVG_DATA_URI = /^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+={0,2}$/

/** Base64 only, so the URI is safe inside CSS `url("…")`. */
export function isAdminIcon(value: unknown): value is AdminIcon {
  return (
    (typeof value === 'string' && (ADMIN_ICON_NAMES as readonly string[]).includes(value)) ||
    (typeof value === 'string' && SVG_DATA_URI.test(value))
  )
}
