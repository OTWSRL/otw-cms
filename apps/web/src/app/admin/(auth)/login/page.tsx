import { safeRedirectPath } from '@cms/core'
import type { SearchParams } from '@cms/sdk'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { AdminScreen } from '@/components/admin'
import { getKernel } from '@/cms/kernel'
import { firstParam } from '@/cms/search-params'
import { getCurrentUser } from '@/cms/session'

export const metadata: Metadata = { title: 'Sign in' }

export default async function LoginPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [kernel, user, params] = await Promise.all([getKernel(), getCurrentUser(), searchParams])
  if (!(await kernel.auth.hasUsers())) redirect('/admin/setup')
  const next = safeRedirectPath(firstParam(params.next)) ?? '/admin'
  if (kernel.can(user, 'core.access_admin')) redirect(next)

  return (
    <AdminScreen title="Sign in" flash={kernel.readFlash(params.flash)}>
      <form method="post" action={kernel.actionUrl('core', 'login')} className="cms-form">
        <input type="hidden" name="next" value={next} />
        <label>
          Email
          <input type="email" name="email" autoComplete="username" required />
        </label>
        <label>
          Password
          <input type="password" name="password" autoComplete="current-password" required />
        </label>
        <button type="submit" className="cms-button">
          Sign in
        </button>
      </form>
    </AdminScreen>
  )
}
