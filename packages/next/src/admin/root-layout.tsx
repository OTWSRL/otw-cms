import type { ReactNode } from 'react'
import { getKernel } from '../runtime/kernel'
import './admin.css'

/**
 * The admin's own root layout, beside the storefront's: the admin's styles never load on the
 * site, and the theme's never load in the admin.
 */
export async function AdminRootLayout({ children }: { children: ReactNode }) {
  const kernel = await getKernel()
  return (
    <html lang={kernel.setting('site.locale') || 'en'}>
      <body>{children}</body>
    </html>
  )
}
