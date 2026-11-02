import type { User } from '@otw/sdk'
import { ActionError } from '@otw/sdk'
import { safeRedirectPath, type InternalAction } from './admin'
import { ACCOUNT_PATH, type AccountService } from './accounts'
import { AuthError, type AuthService } from './auth'
import { clearedSessionCookies, sessionCookie } from './session-cookie'

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

export interface AccountActionDependencies {
  auth: AuthService
  accounts: AccountService
}

/**
 * The account pages' forms: `wp-login.php`'s sign in, register, lost password and reset, and
 * My Account's details. Signed-out forms say the same whether or not an account exists.
 */
export function accountActions({ auth, accounts }: AccountActionDependencies): InternalAction[] {
  const signedIn = (user: User | null): User => {
    if (!user) throw new ActionError('Sign in first.')
    return user
  }
  return [
    {
      name: 'account-sign-in',
      capability: null,
      async handler({ form, secure }) {
        const { token } = await asActionError(() =>
          auth.signIn(field(form, 'email'), field(form, 'password')),
        )
        return {
          redirect: safeRedirectPath(field(form, 'next')) ?? ACCOUNT_PATH,
          cookies: [sessionCookie(token, secure)],
        }
      },
    },
    {
      name: 'account-register',
      capability: null,
      async handler({ form, origin }) {
        if (!accounts.canRegister()) throw new ActionError('This site isn’t taking sign-ups.')
        await asActionError(() =>
          accounts.register({ email: field(form, 'email'), name: field(form, 'name') }, origin),
        )
        // The same whether the address is new or has an account: its email says which.
        return {
          redirect: ACCOUNT_PATH,
          notice: 'Check your email for a link to set your password.',
        }
      },
    },
    {
      name: 'account-lost-password',
      capability: null,
      async handler({ form, origin }) {
        await asActionError(() => accounts.requestPasswordReset(field(form, 'email'), origin))
        return {
          notice: 'If an account uses that address, we’ve emailed it a link to set a new password.',
        }
      },
    },
    {
      name: 'account-reset',
      capability: null,
      async handler({ form, secure }) {
        const user = await asActionError(() =>
          accounts.setPassword(field(form, 'token'), field(form, 'password')),
        )
        // The link proved the address; signing in spares a second step.
        return {
          redirect: ACCOUNT_PATH,
          notice: 'Your password is set, and you’re signed in.',
          cookies: [sessionCookie(await auth.createSession(user.id), secure)],
        }
      },
    },
    {
      name: 'account-name',
      capability: null,
      async handler({ form, user }) {
        await asActionError(() => accounts.changeName(signedIn(user), field(form, 'name')))
        return { redirect: ACCOUNT_PATH, notice: 'Your name was saved.' }
      },
    },
    {
      name: 'account-password',
      capability: null,
      async handler({ form, user, sessionToken }) {
        await asActionError(() =>
          accounts.changePassword(
            signedIn(user),
            field(form, 'current'),
            field(form, 'password'),
            sessionToken,
          ),
        )
        return {
          redirect: ACCOUNT_PATH,
          notice: 'Your password was changed, and your other sessions were signed out.',
        }
      },
    },
    {
      name: 'account-email',
      capability: null,
      async handler({ form, user, origin }) {
        const email = field(form, 'email').trim()
        await asActionError(() =>
          accounts.requestEmailChange(signedIn(user), field(form, 'password'), email, origin),
        )
        return {
          redirect: ACCOUNT_PATH,
          notice: `We’ve emailed ${email} a link to confirm it. Your address changes once it’s used.`,
        }
      },
    },
    {
      name: 'account-confirm-email',
      capability: null,
      async handler({ form }) {
        const user = await asActionError(() => accounts.confirmEmail(field(form, 'token')))
        return { redirect: ACCOUNT_PATH, notice: `Your email address is now ${user.email}.` }
      },
    },
    {
      name: 'account-sign-out',
      capability: null,
      async handler({ sessionToken }) {
        await auth.signOut(sessionToken)
        return {
          redirect: ACCOUNT_PATH,
          notice: 'You are signed out.',
          cookies: clearedSessionCookies(),
        }
      },
    },
  ]
}
