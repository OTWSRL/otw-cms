import 'server-only'
import {
  DEVICE_COOKIE_NAMES,
  SESSION_COOKIE_NAMES,
  SIGN_IN_COOKIE_NAMES,
  type AccountCookies,
  type Kernel,
} from '@otwdesign/core'
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

/** A held sign-in's token and the remembered browser's id, for the screens that ask for a code. */
export async function signInCookies(): Promise<AccountCookies> {
  const jar = await cookies()
  const first = (names: readonly string[]) =>
    names.map((name) => jar.get(name)?.value).find(Boolean) ?? null
  return { signIn: first(SIGN_IN_COOKIE_NAMES), device: first(DEVICE_COOKIE_NAMES) }
}

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
