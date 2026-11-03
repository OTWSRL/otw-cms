import 'server-only'
import { SESSION_COOKIE_NAMES, type Kernel } from '@otwdesign/core'
import type { CapabilityName, User } from '@otwdesign/sdk'
import { cookies } from 'next/headers'
import { forbidden, redirect } from 'next/navigation'
import { cache } from 'react'
import { getKernel } from './kernel'

/** The signed-in user for this request, looked up once however many components ask. */
export const getCurrentUser = cache(async (): Promise<User | null> => {
  const jar = await cookies()
  const token = SESSION_COOKIE_NAMES.map((name) => jar.get(name)?.value).find(Boolean)
  if (!token) return null
  const kernel = await getKernel()
  return kernel.auth.userForSession(token)
})

/**
 * Every admin page calls this itself rather than trusting the layout: layouts are not re-run on
 * every navigation, and a page's payload can be requested on its own.
 */
export async function requireAdmin(
  path: string,
  capability?: CapabilityName,
): Promise<{ kernel: Kernel; user: User }> {
  const [kernel, user] = await Promise.all([getKernel(), getCurrentUser()])
  if (!user) redirect(`/admin/login?next=${encodeURIComponent(path)}`)
  if (!kernel.can(user, 'core.access_admin')) forbidden()
  if (capability && !kernel.can(user, capability)) forbidden()
  return { kernel, user }
}
