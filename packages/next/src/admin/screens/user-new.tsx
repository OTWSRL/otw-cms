import { FormField, FormTable, SubmitButton } from '@otw/admin-ui'
import { MIN_PASSWORD_LENGTH } from '@otw/core'
import { AdminScreen } from '../screen'
import type { ScreenContext } from './context'

/** user-new.php. On success the action returns to the list. */
export async function NewUserScreen({ kernel, searchParams: params }: ScreenContext) {
  const roles = kernel.roles()

  return (
    <AdminScreen title="Add User" flash={kernel.readFlash(params.flash)}>
      <p>Create a brand new user and add them to this site.</p>
      <form method="post" action={kernel.actionUrl('core', 'create-user')}>
        <FormTable>
          <FormField label="Email (required)" htmlFor="email">
            <input
              id="email"
              type="email"
              name="email"
              className="regular-text"
              autoComplete="off"
              required
            />
          </FormField>
          <FormField label="Name" htmlFor="name">
            <input
              id="name"
              name="name"
              className="regular-text"
              autoComplete="off"
              maxLength={100}
            />
          </FormField>
          <FormField
            label="Password (required)"
            htmlFor="password"
            description={`At least ${MIN_PASSWORD_LENGTH} characters.`}
            descriptionId="password-description"
          >
            <input
              id="password"
              type="password"
              name="password"
              className="regular-text"
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              aria-describedby="password-description"
              required
            />
          </FormField>
          <FormField label="Role" htmlFor="role">
            <select id="role" name="role" defaultValue="customer">
              {roles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.label}
                </option>
              ))}
            </select>
          </FormField>
        </FormTable>
        <SubmitButton>Add User</SubmitButton>
      </form>
    </AdminScreen>
  )
}
