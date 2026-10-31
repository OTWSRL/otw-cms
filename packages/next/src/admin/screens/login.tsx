import { safeRedirectPath } from '@cms/core'
import type { SearchParams } from '@cms/sdk'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getKernel } from '../../runtime/kernel'
import { firstParam } from '../../runtime/search-params'
import { getCurrentUser } from '../../runtime/session'
import { BrandMark } from '../brand-mark'
import { FlashNotice } from '../screen'

/** wp-login.php. Signed-in users with admin access go straight to where they were headed. */
export async function LoginScreen({ searchParams: params }: { searchParams: SearchParams }) {
  const [kernel, user] = await Promise.all([getKernel(), getCurrentUser()])
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
