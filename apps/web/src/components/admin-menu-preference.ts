/** The user's choice from the Collapse Menu button, kept in a cookie so the server renders it. */
export type MenuPreference = 'auto' | 'folded' | 'unfolded'

export const MENU_COOKIE = 'cms-admin-menu'

export function menuPreference(value: string | undefined): MenuPreference {
  return value === 'folded' || value === 'unfolded' ? value : 'auto'
}
