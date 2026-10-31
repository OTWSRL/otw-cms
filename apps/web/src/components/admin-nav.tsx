'use client'

import type { AdminMenuSection } from '@cms/core'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

/**
 * The item whose URL is the longest match for the current path, so an edit screen marks its
 * list and `/admin/commerce/settings/payments` marks Payments rather than Shop as well.
 */
function currentUrl(sections: readonly AdminMenuSection[], pathname: string): string | undefined {
  return sections
    .flatMap((section) => section.items.map((item) => item.url))
    .filter((url) => pathname === url || (url !== '/admin' && pathname.startsWith(`${url}/`)))
    .sort((a, b) => b.length - a.length)[0]
}

export function AdminNav({ sections }: { sections: readonly AdminMenuSection[] }) {
  const current = currentUrl(sections, usePathname())
  const link = (url: string, label: string) => (
    <Link href={url} aria-current={url === current ? 'page' : undefined}>
      {label}
    </Link>
  )
  return (
    <nav aria-label="Admin">
      {sections.map((section) =>
        section.items.length === 1 ? (
          <ul key={section.id}>
            <li>{link(section.items[0]!.url, section.label)}</li>
          </ul>
        ) : (
          <section key={section.id} aria-labelledby={`menu-${section.id}`}>
            <h2 id={`menu-${section.id}`}>{section.label}</h2>
            <ul>
              {section.items.map((item) => (
                <li key={item.key}>{link(item.url, item.label)}</li>
              ))}
            </ul>
          </section>
        ),
      )}
    </nav>
  )
}
