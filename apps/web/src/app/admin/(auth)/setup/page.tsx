import { MIN_PASSWORD_LENGTH } from '@cms/core'
import type { SearchParams } from '@cms/sdk'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { FlashNotice } from '@/components/admin'
import { BrandMark } from '@/components/brand-mark'
import { getKernel } from '@/cms/kernel'

export const metadata: Metadata = { title: 'Set up your site' }

/** First run only, like WordPress's installer: once anyone has an account, this sends to log in. */
export default async function SetupPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [kernel, params] = await Promise.all([getKernel(), searchParams])
  if (await kernel.auth.hasUsers()) redirect('/admin/login')

  return (
    <>
      <div className="login-logo">
        <BrandMark />
      </div>
      <h1 className="login-title">Welcome</h1>
      <p className="login-intro">Create the administrator account. You can add more users later.</p>
      <FlashNotice flash={kernel.readFlash(params.flash)} />
      <form method="post" action={kernel.actionUrl('core', 'setup')}>
        <label htmlFor="setup-name">Name</label>
        <input id="setup-name" name="name" className="input" autoComplete="name" maxLength={100} />
        <label htmlFor="setup-email">Email</label>
        <input
          id="setup-email"
          type="email"
          name="email"
          className="input"
          autoComplete="username"
          required
        />
        <label htmlFor="setup-password">Password</label>
        <input
          id="setup-password"
          type="password"
          name="password"
          className="input"
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          required
          aria-describedby="password-help"
        />
        <p className="field-help" id="password-help">
          At least {MIN_PASSWORD_LENGTH} characters.
        </p>
        <p className="login-submit">
          <button type="submit" className="button button-primary">
            Create administrator
          </button>
        </p>
      </form>
    </>
  )
}
