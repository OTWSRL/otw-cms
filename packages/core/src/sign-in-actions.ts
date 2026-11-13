import { ActionError } from '@otwdesign/sdk'
import { ACCOUNT_PATH } from './accounts'
import { LOGIN_PATH, type ActionOutput, type InternalAction } from './admin'
import { AuthError } from './auth'
import {
  clearedSignInCookies,
  DEVICE_COOKIE_NAMES,
  deviceCookie,
  SIGN_IN_COOKIE_NAMES,
  sessionCookie,
  signInCookie,
} from './session-cookie'
import { SIGN_IN_TTL_MS, type SignInService, type SignInStart } from './sign-in'

/** Where a held sign-in's code is asked for: in the admin's frame, and on the site's account pages. */
export const ADMIN_VERIFY_PATH = `${LOGIN_PATH}/verify`
export const ACCOUNT_VERIFY_PATH = `${ACCOUNT_PATH}/verify`

function field(form: FormData, name: string): string {
  const value = form.get(name)
  return typeof value === 'string' ? value : ''
}

async function asActionError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof AuthError) throw new ActionError(error.message)
    throw error
  }
}

/**
 * What follows a sign-in begun: the session's cookie and the way on, or the held sign-in's
 * cookie and the screen that asks for its code.
 */
export function startedSignIn(
  start: SignInStart,
  input: { secure: boolean; next: string; screen: 'admin' | 'account'; notice?: string },
): ActionOutput {
  if (start.kind === 'session') {
    return {
      redirect: input.next,
      notice: input.notice,
      cookies: [sessionCookie(start.token, input.secure)],
    }
  }
  return {
    redirect: input.screen === 'admin' ? ADMIN_VERIFY_PATH : ACCOUNT_VERIFY_PATH,
    notice: start.problem ?? undefined,
    cookies: [signInCookie(start.token, input.secure, SIGN_IN_TTL_MS / 1000)],
  }
}

/** The forms of the screen that asks for a held sign-in's code. They work signed out. */
export function signInActions(signIns: SignInService): InternalAction[] {
  return [
    {
      name: 'sign-in-verify',
      capability: null,
      async handler({ form, secure, cookie }) {
        const done = await asActionError(() =>
          signIns.complete(cookie(SIGN_IN_COOKIE_NAMES), {
            method: field(form, 'method'),
            code: field(form, 'code'),
            remember: form.has('remember'),
            device: cookie(DEVICE_COOKIE_NAMES),
          }),
        )
        return {
          redirect: done.next,
          cookies: [
            sessionCookie(done.session, secure),
            ...clearedSignInCookies(),
            ...(done.device ? [deviceCookie(done.device.token, secure, done.device.days)] : []),
          ],
        }
      },
    },
    {
      // Sends a code again, or switches to a way that sends one.
      name: 'sign-in-send',
      capability: null,
      async handler({ form, cookie }) {
        const method = field(form, 'method')
        await asActionError(() =>
          signIns.send(cookie(SIGN_IN_COOKIE_NAMES), method, cookie(DEVICE_COOKIE_NAMES)),
        )
        const screen = field(form, 'screen') === 'account' ? ACCOUNT_VERIFY_PATH : ADMIN_VERIFY_PATH
        return {
          redirect: `${screen}?method=${encodeURIComponent(method)}`,
          notice: 'A new code is on its way.',
        }
      },
    },
  ]
}
