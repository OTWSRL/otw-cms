import { ADMIN_LINK } from '@otwdesign/admin-ui'

/**
 * Where a click on a plain link marked `data-admin-link` (admin-ui's Tabs) should take the
 * admin's router, or null when the browser should follow it itself: another button or a key
 * held, a new tab, a download, another site, an address outside the admin, or a click a script
 * already handled.
 */
export function adminLinkTarget(event: MouseEvent): string | null {
  if (event.defaultPrevented || event.button !== 0) return null
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null
  const link = event.target instanceof Element ? event.target.closest(`a[${ADMIN_LINK}]`) : null
  if (!(link instanceof HTMLAnchorElement)) return null
  if ((link.target && link.target !== '_self') || link.hasAttribute('download')) return null
  const url = new URL(link.href, window.location.href)
  if (url.origin !== window.location.origin) return null
  if (url.pathname !== '/admin' && !url.pathname.startsWith('/admin/')) return null
  return `${url.pathname}${url.search}${url.hash}`
}
