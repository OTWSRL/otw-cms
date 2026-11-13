import { ADMIN_VERIFY_PATH, LOGIN_PATH } from '@otwdesign/core'
import type { SearchParams, SignInMethod } from '@otwdesign/sdk'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getKernel } from '../../runtime/kernel'
import { firstParam } from '../../runtime/search-params'
import { getCurrentUser, signInCookies } from '../../runtime/session'
import { BrandMark } from '../brand-mark'
import { FlashNotice } from '../screen'

/** Another way to get a code: one that sends is a button, since a link mustn't send anything. */
function OtherWay({ method, sendUrl }: { method: SignInMethod; sendUrl: string }) {
  if (!method.sends) {
    return (
      <Link href={`${ADMIN_VERIFY_PATH}?method=${encodeURIComponent(method.id)}`}>
        {method.label}
      </Link>
    )
  }
  return (
    <form method="post" action={sendUrl} className="login-plain">
      <input type="hidden" name="method" value={method.id} />
      <button type="submit" className="button-link">
        {method.label}
      </button>
    </form>
  )
}

/**
 * The step a plugin adds after a correct password, in wp-login.php's frame as two-factor
 * plugins show theirs: the code, a way to get another, and the person's other ways.
 */
export async function LoginVerifyScreen({ searchParams: params }: { searchParams: SearchParams }) {
  const [kernel, cookies] = await Promise.all([getKernel(), signInCookies()])
  const held = await kernel.signIns.held(cookies.signIn, cookies.device)
  const flash = kernel.readFlash(params.flash)
  if (!held) {
    // Nothing waiting: someone signed in has no business here, and anyone else starts again.
    if (kernel.can(await getCurrentUser(), 'core.access_admin')) redirect('/admin')
    return (
      <>
        <div className="login-logo">
          <BrandMark brand={kernel.brand} />
        </div>
        <h1 className="login-title">That sign-in has run out</h1>
        <p className="login-intro">Log in again to get a new code.</p>
        <FlashNotice flash={flash} />
        <p className="login-links">
          <Link href={LOGIN_PATH}>← Back to log in</Link>
        </p>
      </>
    )
  }
  const asked = firstParam(params.method)
  const method = held.methods.find((candidate) => candidate.id === asked) ?? held.methods[0]!
  const others = held.methods.filter((candidate) => candidate.id !== method.id)
  const sendUrl = kernel.actionUrl('core', 'sign-in-send')

  return (
    <>
      <div className="login-logo">
        <BrandMark brand={kernel.brand} />
      </div>
      <h1 className="login-title">Verify it’s you</h1>
      <FlashNotice flash={flash} />
      <form method="post" action={kernel.actionUrl('core', 'sign-in-verify')}>
        <input type="hidden" name="method" value={method.id} />
        <p className="login-prompt" id="verify-prompt">
          {method.prompt}
        </p>
        <label htmlFor="verify-code">Code</label>
        <input
          id="verify-code"
          name="code"
          className="input"
          inputMode={method.numeric ? 'numeric' : 'text'}
          autoComplete="one-time-code"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={64}
          aria-describedby="verify-prompt"
          autoFocus
          required
        />
        {held.rememberDays > 0 && (
          <p className="login-remember">
            <label>
              <input type="checkbox" name="remember" /> Don’t ask again on this device for{' '}
              {held.rememberDays} {held.rememberDays === 1 ? 'day' : 'days'}
            </label>
          </p>
        )}
        <p className="login-submit">
          <button type="submit" className="button button-primary">
            Verify
          </button>
        </p>
      </form>
      {method.sends && (
        <div className="login-links">
          <form method="post" action={sendUrl} className="login-plain">
            <input type="hidden" name="method" value={method.id} />
            <button type="submit" className="button-link">
              Send a new code
            </button>
          </form>
        </div>
      )}
      {others.length > 0 && (
        <nav className="login-links" aria-label="Other ways to verify">
          <span className="login-ways-title">Try another way:</span>
          <ul className="login-ways">
            {others.map((other) => (
              <li key={other.id}>
                <OtherWay method={other} sendUrl={sendUrl} />
              </li>
            ))}
          </ul>
        </nav>
      )}
      <p className="login-links">
        <Link href={LOGIN_PATH}>← Back to log in</Link>
      </p>
    </>
  )
}
