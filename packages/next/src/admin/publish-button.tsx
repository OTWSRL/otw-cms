'use client'

import { Button } from '@otwdesign/admin-ui'
import { useEffect, useState } from 'react'

/** A minute, as the server has it (wp_insert_post()): a date this far ahead schedules. */
const AHEAD_MS = 60_000

/** Whether a `datetime-local` value, read as UTC like the admin's dates, is a minute or more ahead. */
function isAhead(value: string): boolean {
  if (!value) return false
  const time = Date.parse(`${value}${value.length === 16 ? ':00' : ''}Z`)
  return !Number.isNaN(time) && time - Date.now() >= AHEAD_MS
}

/**
 * The Publish box's main button for an entry that isn't published yet. It reads "Schedule" while
 * the date field holds a time ahead, as WordPress's does, and "Publish" otherwise.
 */
export function PublishButton({
  dateField,
  scheduling,
}: {
  /** The id of the date input it follows. */
  dateField: string
  /** Whether the date the screen was rendered with is ahead. */
  scheduling: boolean
}) {
  const [ahead, setAhead] = useState(scheduling)
  useEffect(() => {
    const input = document.getElementById(dateField)
    if (!(input instanceof HTMLInputElement)) return
    const follow = () => setAhead(isAhead(input.value))
    follow()
    input.addEventListener('input', follow)
    return () => input.removeEventListener('input', follow)
  }, [dateField])
  return (
    <Button type="submit" name="intent" value="publish" variant="primary">
      {ahead ? 'Schedule' : 'Publish'}
    </Button>
  )
}
