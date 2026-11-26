// @vitest-environment happy-dom
import { ADMIN_LINK } from '@otwdesign/admin-ui'
import { afterEach, describe, expect, it } from 'vitest'
import { adminLinkTarget } from '../src/admin/admin-links'

afterEach(() => document.body.replaceChildren())

/** A click on a link with these attributes: where the admin's router would go. */
function clickTarget(
  href: string,
  attributes: Record<string, string> = { [ADMIN_LINK]: '' },
  init: MouseEventInit = {},
  handled = false,
): string | null {
  const link = document.createElement('a')
  link.href = href
  link.innerHTML = '<span>Drive</span>'
  for (const [name, value] of Object.entries(attributes)) link.setAttribute(name, value)
  document.body.append(link)
  // Not dispatched: the test's browser would follow the link. On the link's text, as a click is.
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init })
  Object.defineProperty(event, 'target', { value: link.querySelector('span') })
  if (handled) event.preventDefault()
  return adminLinkTarget(event)
}

describe('a marked link in the admin', () => {
  it('goes through the router to another admin screen, query and all', () => {
    expect(clickTarget('/admin/google/drive?account=a#files')).toBe(
      '/admin/google/drive?account=a#files',
    )
    expect(clickTarget('/admin')).toBe('/admin')
  })

  it('is left to the browser when it isn’t marked, or isn’t a plain click on an admin screen', () => {
    expect(clickTarget('/admin/google/drive', {})).toBeNull()
    expect(clickTarget('/admin/x', { [ADMIN_LINK]: '', target: '_blank' })).toBeNull()
    expect(clickTarget('/admin/x', { [ADMIN_LINK]: '', download: '' })).toBeNull()
    expect(clickTarget('https://example.com/admin/x')).toBeNull()
    expect(clickTarget('/api/p/google/oauth/start')).toBeNull()
    expect(clickTarget('/administrator')).toBeNull()
    for (const key of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey'] as const) {
      expect({ key, target: clickTarget('/admin/x', undefined, { [key]: true }) }).toEqual({
        key,
        target: null,
      })
    }
    expect(clickTarget('/admin/x', undefined, { button: 1 })).toBeNull()
    expect(clickTarget('/admin/x', undefined, {}, true)).toBeNull()
  })
})
