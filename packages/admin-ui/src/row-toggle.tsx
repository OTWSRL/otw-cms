'use client'

import { useState } from 'react'

/**
 * On phones a list table shows only its primary column; this shows the rest of the row, as
 * WordPress's "Show more details" button does. The class drives the CSS, so it sits on the row.
 */
export function RowToggle() {
  const [expanded, setExpanded] = useState(false)
  return (
    <button
      type="button"
      className="toggle-row"
      aria-expanded={expanded}
      onClick={(event) => {
        event.currentTarget.closest('tr')?.classList.toggle('is-expanded', !expanded)
        setExpanded(!expanded)
      }}
    >
      <span className="screen-reader-text">
        {expanded ? 'Show fewer details' : 'Show more details'}
      </span>
    </button>
  )
}
