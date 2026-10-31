import { MIN_PASSWORD_LENGTH } from '@cms/core'
import type { SearchParams } from '@cms/sdk'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { AdminScreen } from '@/components/admin'
import { getKernel } from '@/cms/kernel'

export const metadata: Metadata = { title: 'Set up your site' }

/** First run only: once anyone has an account, this page sends visitors to sign in. */
export default async function SetupPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [kernel, params] = await Promise.all([getKernel(), searchParams])
  if (await kernel.auth.hasUsers()) redirect('/admin/login')

  return (
    <AdminScreen title="Set up your site" flash={kernel.readFlash(params.flash)}>
      <p>Create the administrator account. You can add more users later.</p>
      <form method="post" action={kernel.actionUrl('core', 'setup')} className="cms-form">
        <label>
          Name
          <input name="name" autoComplete="name" maxLength={100} />
        </label>
        <label>
          Email
          <input type="email" name="email" autoComplete="username" required />
        </label>
        <label>
          Password
          <input
            type="password"
            name="password"
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            required
            aria-describedby="password-help"
          />
          <small id="password-help">At least {MIN_PASSWORD_LENGTH} characters.</small>
        </label>
        <button type="submit" className="cms-button">
          Create administrator
        </button>
      </form>
    </AdminScreen>
  )
}
