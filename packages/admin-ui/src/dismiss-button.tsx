'use client'

/** The × on an `is-dismissible` notice. Hides it for this page view; nothing is stored. */
export function DismissButton() {
  return (
    <button
      type="button"
      className="notice-dismiss"
      onClick={(event) => {
        const notice = event.currentTarget.closest('.notice')
        if (notice instanceof HTMLElement) notice.hidden = true
      }}
    >
      <span className="screen-reader-text">Dismiss this notice.</span>
    </button>
  )
}
