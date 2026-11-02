'use client'

import { useEffect, useRef } from 'react'

/** A navigation faster than this shows no bar: it would only flash. */
export const SHOW_AFTER_MS = 150
/** A navigation that never arrives (a script that cancelled it) stops showing after this. */
const GIVE_UP_MS = 15_000
const FADE_MS = 300

let cancelCurrent: (() => void) | null = null

/**
 * Stops the bar for a click that turned out not to navigate, such as the touch menu's first tap,
 * which opens a section's flyout instead.
 */
export function cancelNavigationProgress(): void {
  cancelCurrent?.()
}

/** Whether a click on `link` leaves for another admin address, in this tab. */
function navigatesAway(event: MouseEvent, link: HTMLAnchorElement): boolean {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return false
  }
  if ((link.target && link.target !== '_self') || link.hasAttribute('download')) return false
  const url = new URL(link.href, window.location.href)
  const here = window.location
  return (
    url.origin === here.origin && (url.pathname !== here.pathname || url.search !== here.search)
  )
}

/**
 * A thin bar along the top of the admin while the next screen loads, as soon as a link or form is
 * used, so a click on a slow connection is seen to have worked. Started on the click itself:
 * `<Link>` cancels the browser's navigation to make its own, so whether one was cancelled says
 * nothing. Finished when the address changes, the page is shown again from the back-forward
 * cache, or the navigation is cancelled.
 */
export function NavigationProgress() {
  const bar = useRef<HTMLDivElement>(null)
  const from = useRef<string | null>(null)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  const show = (state: 'idle' | 'pending' | 'showing' | 'done') => {
    if (bar.current) bar.current.dataset.state = state
  }
  const clearTimers = () => {
    for (const timer of timers.current) clearTimeout(timer)
    timers.current = []
  }
  const finish = () => {
    clearTimers()
    from.current = null
    if (bar.current?.dataset.state === 'showing') {
      show('done')
      timers.current.push(setTimeout(() => show('idle'), FADE_MS))
    } else {
      show('idle')
    }
  }

  // After every render of the frame: a soft navigation that changed the address has arrived.
  useEffect(() => {
    if (from.current !== null && from.current !== window.location.href) finish()
  })

  useEffect(() => {
    const start = () => {
      clearTimers()
      from.current = window.location.href
      show('pending')
      timers.current.push(
        setTimeout(() => show('showing'), SHOW_AFTER_MS),
        setTimeout(finish, GIVE_UP_MS),
      )
    }
    const onClick = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null
      if (link instanceof HTMLAnchorElement && navigatesAway(event, link)) start()
    }
    // Forms post to actions and come back as a new page; a script's own submit is left alone.
    const onSubmit = (event: SubmitEvent) => {
      const form = event.target
      if (event.defaultPrevented || !(form instanceof HTMLFormElement)) return
      if (form.target && form.target !== '_self') return
      start()
    }
    const onShow = () => finish()
    cancelCurrent = finish
    document.addEventListener('click', onClick, true)
    document.addEventListener('submit', onSubmit)
    window.addEventListener('pageshow', onShow)
    return () => {
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('submit', onSubmit)
      window.removeEventListener('pageshow', onShow)
      if (cancelCurrent === finish) cancelCurrent = null
      clearTimers()
    }
    // Registered once; finish and start read refs, not render state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <div ref={bar} className="nav-progress" data-state="idle" aria-hidden="true" />
}
