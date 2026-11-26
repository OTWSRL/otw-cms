'use client'

import type { ReactNode } from 'react'
import { useInAdminFrame } from './admin-frame'

/**
 * WordPress's wp_die() box. Inside the admin's frame (someone who may use the admin, on a screen
 * they may not open) it sits where the screen would; without it, on a page of its own.
 */
export function DieBox({ children }: { children: ReactNode }) {
  const box = <div className="cms-die">{children}</div>
  if (useInAdminFrame()) return box
  return <main className="cms-login">{box}</main>
}
