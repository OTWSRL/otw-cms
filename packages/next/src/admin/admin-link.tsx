import Link from 'next/link'
import type { ComponentProps } from 'react'

/**
 * A link to one of the admin's screens. Next.js asks the server about every link in view as soon
 * as a page shows, to have the next page ready; the admin's screens are made per request, so
 * that answer holds nothing a click could use, and the menu alone has more than a dozen links.
 * These ask nothing until they're clicked.
 */
export function AdminLink(props: Omit<ComponentProps<typeof Link>, 'prefetch'>) {
  return <Link {...props} prefetch={false} />
}
