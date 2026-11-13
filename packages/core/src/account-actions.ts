import type { User, UserMetaChanges, UserMetaField } from '@otwdesign/sdk'
import { ActionError, ContentError } from '@otwdesign/sdk'
import { safeRedirectPath, type InternalAction } from './admin'
import { ACCOUNT_PATH, type AccountService } from './accounts'
import { AuthError, type AuthService } from './auth'
import { metaFromForm } from './content-actions'
import type { UsersService } from './users'
import { clearedSessionCookies, DEVICE_COOKIE_NAMES } from './session-cookie'
import type { SignInService } from './sign-in'
import { startedSignIn } from './sign-in-actions'

function field(form: FormData, name: string): string {
  const value = form.get(name)
  return typeof value === 'string' ? value : ''
}

/** Where a form goes after saving: the account, or the admin's Profile, which shares the forms. */
const back = (form: FormData) => safeRedirectPath(field(form, 'redirect')) ?? ACCOUNT_PATH

async function asActionError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof AuthError || error instanceof ContentError) {
      throw new ActionError(error.message)
    }
    throw error
  }
}

export interface AccountActionDependencies {
  auth: AuthService
  signIns: SignInService
  accounts: AccountService
  users: UsersService
}

/** A form's user field inputs as changes; an empty one removes the field. */
export function metaChanges(fields: readonly UserMetaField[], form: FormData): UserMetaChanges {
  return Object.fromEntries(
    fields.map((meta) => [meta.key, metaFromForm(meta, form)]),
  ) as UserMetaChanges
}

/**
 * The account pages' forms: `wp-login.php`'s sign in, register, lost password and reset, and
 * My Account's details. Signed-out forms say the same whether or not an account exists.
 */
export function accountActions({
  auth,
  signIns,
  accounts,
  users,
}: AccountActionDependencies): InternalAction[] {
  const signedIn = (user: User | null): User => {
    if (!user) throw new ActionError('Sign in first.')
    return user
  }
  return [
    {
      name: 'account-sign-in',
      capability: null,
      async handler({ form, secure, cookie }) {
        const next = safeRedirectPath(field(form, 'next')) ?? ACCOUNT_PATH
        const start = await asActionError(async () => {
          const user = await auth.identify(field(form, 'email'), field(form, 'password'))
          const device = cookie(DEVICE_COOKIE_NAMES)
          return signIns.begin(user, { via: 'password', next, device })
        })
        return startedSignIn(start, { secure, next, screen: 'account' })
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
      async handler({ form, secure, cookie }) {
        // The link proved the address, which spares signing in with the new password. A
        // sign-in step still asks for its code: an inbox alone mustn't open the account.
        const start = await asActionError(async () => {
          const user = await accounts.setPassword(field(form, 'token'), field(form, 'password'))
          const device = cookie(DEVICE_COOKIE_NAMES)
          return signIns.begin(user, { via: 'link', next: ACCOUNT_PATH, device })
        })
        const held = start.kind === 'held'
        return {
          ...startedSignIn(start, { secure, next: ACCOUNT_PATH, screen: 'account' }),
          notice: held
            ? (start.problem ?? 'Your password is set. Enter a code to finish signing in.')
            : 'Your password is set, and you’re signed in.',
        }
      },
    },
    {
      name: 'account-name',
      capability: null,
      async handler({ form, user }) {
        const me = signedIn(user)
        // Only the fields the account page shows: the rest are the admin's to change.
        const shown = users
          .fields(me.role)
          .filter(
            (meta) => meta.definition.onAccount && form.getAll('userFields').includes(meta.key),
          )
        await asActionError(async () => {
          await accounts.changeName(me, field(form, 'name'))
          if (shown.length > 0) await users.updateMeta(me.id, metaChanges(shown, form))
        })
        return { redirect: back(form), notice: 'Your details were saved.' }
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
          redirect: back(form),
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
          redirect: back(form),
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
