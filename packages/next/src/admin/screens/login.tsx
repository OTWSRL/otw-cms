import { ACCOUNT_PATH, safeRedirectPath } from '@otwdesign/core'
import type { SearchParams } from '@otwdesign/sdk'
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
  const site = kernel.setting('site.title') ?? 'My Site'
  // As wp-login.php's logo says "Powered by WordPress" and links to wordpress.org.
  const { brand } = kernel
  const logo = brand.url
    ? { href: brand.url, label: `Powered by ${brand.name}` }
    : { href: '/', label: site }

  return (
    <>
      <h1>
        <Link href={logo.href} className="login-logo">
          <BrandMark brand={brand} />
          <span className="screen-reader-text">{logo.label}</span>
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
        <Link href={`${ACCOUNT_PATH}/lost-password`}>Lost your password?</Link>
      </p>
      <p className="login-links">
        <Link href="/">← Go to {site}</Link>
      </p>
    </>
  )
}
