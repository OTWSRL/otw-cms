import type { CapabilityName, User } from '@otw/sdk'
import { ActionError, ContentError, ForbiddenError } from '@otw/sdk'
import type { InternalAction } from './admin'
import { metaChanges } from './account-actions'
import type { AccountService } from './accounts'
import { AuthError, type AuthService } from './auth'
import type { UsersService } from './users'

export const PROFILE_PATH = '/admin/profile'

function field(form: FormData, name: string): string {
  const value = form.get(name)
  return typeof value === 'string' ? value : ''
}

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

export interface UserActionDependencies {
  auth: AuthService
  accounts: AccountService
  users: UsersService
  can(user: User, capability: CapabilityName): boolean
}

/**
 * profile.php and user-edit.php: one's own name and fields, and an administrator's changes to
 * someone else's: name, address, role, fields, a reset link, and ending their sessions.
 */
export function userActions(deps: UserActionDependencies): InternalAction[] {
  const { auth, accounts, users, can } = deps

  /** The fields the form showed, for the role, each needing its own capability if it has one. */
  const shownFields = (form: FormData, role: string, editor: User) => {
    const shown = new Set(form.getAll('userFields').filter((key) => typeof key === 'string'))
    const fields = users.fields(role).filter((meta) => shown.has(meta.key))
    for (const meta of fields) {
      const capability = meta.definition.capability
      if (capability && !can(editor, capability)) throw new ForbiddenError()
    }
    return fields
  }

  const target = async (form: FormData) => {
    const user = await users.get(field(form, 'user'))
    if (!user) throw new ActionError('That user no longer exists.')
    return user
  }

  return [
    {
      name: 'profile-save',
      capability: 'core.access_admin',
      async handler({ form, user }) {
        const me = user!
        const fields = shownFields(form, me.role, me)
        await asActionError(async () => {
          await accounts.changeName(me, field(form, 'name'))
          if (fields.length > 0) await users.updateMeta(me.id, metaChanges(fields, form))
        })
        return { redirect: PROFILE_PATH, notice: 'Profile updated.' }
      },
    },
    {
      // WordPress's "Log Out Everywhere Else".
      name: 'profile-sessions',
      capability: 'core.access_admin',
      async handler({ user, sessionToken }) {
        await auth.signOutEverywhere(user!.id, sessionToken)
        return { redirect: PROFILE_PATH, notice: 'You are now logged out everywhere else.' }
      },
    },
    {
      name: 'user-save',
      capability: 'core.manage_users',
      async handler({ form, user }) {
        const subject = await target(form)
        const role = field(form, 'role') || subject.role
        const fields = shownFields(form, role, user!)
        await asActionError(async () => {
          await accounts.changeName(subject, field(form, 'name'))
          await accounts.setEmail(subject, field(form, 'email'))
          if (role !== subject.role) await auth.setRole(subject.id, role)
          if (fields.length > 0) await users.updateMeta(subject.id, metaChanges(fields, form))
        })
        return { redirect: `/admin/users/${subject.id}`, notice: 'User updated.' }
      },
    },
    {
      // user-edit.php's "Send Reset Link".
      name: 'user-send-reset',
      capability: 'core.manage_users',
      async handler({ form, origin }) {
        const subject = await target(form)
        await asActionError(() => accounts.requestPasswordReset(subject.email, origin))
        return {
          redirect: `/admin/users/${subject.id}`,
          notice: `A link to set a new password is on its way to ${subject.email}, unless it had three in the last hour.`,
        }
      },
    },
    {
      // user-edit.php's "Log Out Everywhere".
      name: 'user-sessions',
      capability: 'core.manage_users',
      async handler({ form }) {
        const subject = await target(form)
        await auth.signOutEverywhere(subject.id)
        return {
          redirect: `/admin/users/${subject.id}`,
          notice: `${subject.name || subject.email} is now logged out everywhere.`,
        }
      },
    },
  ]
}
