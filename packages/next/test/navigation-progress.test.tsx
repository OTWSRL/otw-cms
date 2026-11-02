// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cancelNavigationProgress,
  NavigationProgress,
  SHOW_AFTER_MS,
} from '../src/admin/navigation-progress'

// React's act() wants this flag in a non-React-test environment.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
const bar = () => document.querySelector<HTMLElement>('.nav-progress')!.dataset.state
/** The admin frame renders again when a soft navigation brings the next screen. */
const render = () => act(() => root.render(<NavigationProgress />))

/** Links as screens have them, outside React: the bar listens on the document. */
function addLinks() {
  const links: [string, string, Record<string, string>][] = [
    ['Posts', '/admin/posts', {}],
    ['New tab', '/admin/media', { target: '_blank' }],
    ['Download', '/uploads/a.pdf', { download: '' }],
    ['Elsewhere', 'https://example.com/', {}],
    ['Same page', '/admin#top', {}],
  ]
  for (const [text, href, attributes] of links) {
    const link = document.createElement('a')
    link.href = href
    link.textContent = text
    for (const [name, value] of Object.entries(attributes)) link.setAttribute(name, value)
    document.body.append(link)
  }
}

const click = (text: string, init: MouseEventInit = {}) => {
  const link = [...document.querySelectorAll('a')].find((a) => a.textContent === text)!
  // As <Link> does: the browser's navigation is cancelled, and the router makes its own.
  link.addEventListener('click', (event) => event.preventDefault(), { once: true })
  act(() => {
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }))
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  window.history.replaceState(null, '', '/admin')
  const container = document.createElement('div')
  document.body.append(container)
  addLinks()
  root = createRoot(container)
  render()
})

afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('the navigation bar', () => {
  it('shows only once a navigation has taken a moment, and goes when the next screen is in', () => {
    click('Posts')
    expect(bar()).toBe('pending')
    act(() => vi.advanceTimersByTime(SHOW_AFTER_MS))
    expect(bar()).toBe('showing')
    window.history.pushState(null, '', '/admin/posts')
    render()
    expect(bar()).toBe('done')
    act(() => vi.advanceTimersByTime(300))
    expect(bar()).toBe('idle')
  })

  it('never shows for a navigation faster than that', () => {
    click('Posts')
    window.history.pushState(null, '', '/admin/posts')
    render()
    expect(bar()).toBe('idle')
  })

  it('stays out of clicks that don’t leave: new tabs, downloads, other sites, the same page', () => {
    for (const text of ['New tab', 'Download', 'Elsewhere', 'Same page']) click(text)
    click('Posts', { metaKey: true })
    expect(bar()).toBe('idle')
  })

  it('stops for a click that turned out to open a menu instead', () => {
    click('Posts')
    act(() => cancelNavigationProgress())
    act(() => vi.advanceTimersByTime(SHOW_AFTER_MS))
    expect(bar()).toBe('idle')
  })

  it('shows for a form posting to an action, but not one a script handles', () => {
    const form = document.createElement('form')
    document.body.append(form)
    form.addEventListener('submit', (event) => event.preventDefault(), { once: true })
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(bar()).toBe('idle')
    const posted = document.createElement('form')
    document.body.append(posted)
    act(() => {
      posted.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(bar()).toBe('pending')
  })
})
