import type { Flash } from '@cms/core'
import type { ReactNode } from 'react'

/** `Plugins · Admin · My Site`; without a page, the template for one. */
export function adminTitle(site: string, page = '%s'): string {
  return `${page} · Admin · ${site}`
}

/** The heading and one-time message every admin screen starts with. */
export function AdminScreen({
  title,
  flash,
  children,
}: {
  title: string
  flash: Flash | null
  children: ReactNode
}) {
  return (
    <>
      <h1>{title}</h1>
      {flash && (
        <p
          role={flash.kind === 'error' ? 'alert' : 'status'}
          className={`cms-flash cms-flash-${flash.kind}`}
        >
          {flash.message}
        </p>
      )}
      {children}
    </>
  )
}
