import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { getKernel } from '@/cms/kernel'
import './globals.css'

// Every page depends on the database and the active plugins, so nothing is prerendered at build.
export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  const kernel = await getKernel()
  const site = kernel.setting('site.title') ?? 'Next CMS'
  return { title: { default: site, template: `%s · ${site}` } }
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
