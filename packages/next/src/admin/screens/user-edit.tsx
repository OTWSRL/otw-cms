import { FormButton, FormField, FormTable, SubmitButton } from '@otw/admin-ui'
import type { Kernel } from '@otw/core'
import type { SearchParams, User } from '@otw/sdk'
import Link from 'next/link'
import { AdminScreen } from '../screen'
import { MetaFields } from './meta-fields'

/**
 * user-edit.php: someone else's name, address (changed at once, the old one told), role and
 * fields, with Send Reset Link and Log Out Everywhere.
 */
export async function UserEditScreen({
  kernel,
  user,
  target,
  searchParams,
}: {
  kernel: Kernel
  user: User
  target: User
  searchParams: SearchParams
}) {
  const [meta, verified] = await Promise.all([
    kernel.users.getMeta(target.id),
    kernel.users.isVerified(target.id),
  ])
  const fields = kernel.users.fields(target.role)
  const who = target.name || target.email

  return (
    <AdminScreen
      title={`Edit User ${who}`}
      titleAction={{ label: 'Add User', url: '/admin/users/new' }}
      flash={kernel.readFlash(searchParams.flash)}
    >
      <p>
        <Link href="/admin/users">← Back to Users</Link>
      </p>
      <form method="post" action={kernel.actionUrl('core', 'user-save')}>
        <input type="hidden" name="user" value={target.id} />
        <FormTable>
          <FormField label="Role" htmlFor="user-role">
            <select id="user-role" name="role" defaultValue={target.role}>
              {kernel.roles().map((role) => (
                <option key={role.id} value={role.id}>
                  {role.label}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Name" htmlFor="user-name">
            <input
              id="user-name"
              name="name"
              className="regular-text"
              defaultValue={target.name}
              maxLength={100}
              autoComplete="off"
            />
          </FormField>
          <FormField
            label="Email (required)"
            htmlFor="user-email"
            description={
              verified
                ? 'Confirmed. A new address is told to the old one, and isn’t confirmed until the person uses a link sent to it.'
                : 'Not confirmed yet: the person hasn’t used a link sent to it.'
            }
          >
            <input
              id="user-email"
              type="email"
              name="email"
              className="regular-text"
              defaultValue={target.email}
              autoComplete="off"
              required
            />
          </FormField>
        </FormTable>
        {fields.length > 0 && (
          <>
            <h2>Profile fields</h2>
            <MetaFields
              fields={fields}
              meta={meta}
              listName="userFields"
              editable={(field) =>
                !field.definition.capability || kernel.can(user, field.definition.capability)
              }
            />
          </>
        )}
        <SubmitButton>Update User</SubmitButton>
      </form>

      <h2>Account Management</h2>
      <FormTable>
        <FormField
          label="Password Reset"
          description={`Sends ${who} a link to set a new password.`}
        >
          <FormButton
            action={kernel.actionUrl('core', 'user-send-reset')}
            fields={{ user: target.id }}
          >
            Send Reset Link
          </FormButton>
        </FormField>
        <FormField label="Sessions" description={`Signs ${who} out on every device.`}>
          <FormButton
            action={kernel.actionUrl('core', 'user-sessions')}
            fields={{ user: target.id }}
          >
            Log Out Everywhere
          </FormButton>
        </FormField>
      </FormTable>
    </AdminScreen>
  )
}
