import { safeRedirectPath } from '@cms/core'
import type { SearchParams } from '@cms/sdk'
import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { FlashNotice } from '@/components/admin'
import { BrandMark } from '@/components/brand-mark'
import { getKernel } from '@/cms/kernel'
import { firstParam } from '@/cms/search-params'
import { getCurrentUser } from '@/cms/session'

export const metadata: Metadata = { title: 'Log In' }

export default async function LoginPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [kernel, user, params] = await Promise.all([getKernel(), getCurrentUser(), searchParams])
  if (!(await kernel.auth.hasUsers())) redirect('/admin/setup')
  const next = safeRedirectPath(firstParam(params.next)) ?? '/admin'
  if (kernel.can(user, 'core.access_admin')) redirect(next)
  const site = kernel.setting('site.title') ?? 'Next CMS'

  return (
    <>
      <h1>
        <Link href="/" className="login-logo">
          <BrandMark />
          <span className="screen-reader-text">{site}</span>
        </Link>
      </h1>
      <FlashNotice flash={kernel.readFlash(params.flash)} />
      <form method="post" action={kernel.actionUrl('core', 'login')}>
        <input type="hidden" name="next" value={next} />
        <label htmlFor="user-login">Email Address</label>
        <input
          id="user-login"
          type="email"
          name="email"
          className="input"
          autoComplete="username"
          required
        />
        <label htmlFor="user-pass">Password</label>
        <input
          id="user-pass"
          type="password"
          name="password"
          className="input"
          autoComplete="current-password"
          required
        />
        <p className="login-submit">
          <button type="submit" className="button button-primary">
            Log In
          </button>
        </p>
      </form>
      <p className="login-links">
        <Link href="/">← Go to {site}</Link>
      </p>
    </>
  )
}
