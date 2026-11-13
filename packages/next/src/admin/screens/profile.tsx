import { Button, FormButton, FormField, FormTable, SubmitButton } from '@otwdesign/admin-ui'
import { MIN_PASSWORD_LENGTH } from '@otwdesign/core'
import { Slot } from '../../site/slot'
import { AdminScreen } from '../screen'
import type { ScreenContext } from './context'
import { MetaFields } from './meta-fields'

const PROFILE = '/admin/profile'

/**
 * profile.php: your own name and the fields plugins give you, your email address (changed once
 * the new one confirms), your password, and Log Out Everywhere Else.
 */
export async function ProfileScreen({ kernel, user, searchParams }: ScreenContext) {
  const [meta, verified] = await Promise.all([
    kernel.users.getMeta(user.id),
    kernel.users.isVerified(user.id),
  ])
  const fields = kernel.users.fields(user.role)
  const actions = (name: string) => kernel.actionUrl('core', name)

  return (
    <AdminScreen title="Profile" flash={kernel.readFlash(searchParams.flash)}>
      <form method="post" action={actions('profile-save')}>
        <h2>Name</h2>
        <FormTable>
          <FormField label="Name" htmlFor="profile-name">
            <input
              id="profile-name"
              name="name"
              className="regular-text"
              defaultValue={user.name}
              maxLength={100}
              autoComplete="name"
            />
          </FormField>
        </FormTable>
        {fields.length > 0 && (
          <>
            <h2>About you</h2>
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
        <SubmitButton>Update Profile</SubmitButton>
      </form>

      <h2>Email address</h2>
      <p>
        {user.email}
        {verified ? ' (confirmed)' : ' (not confirmed yet)'}
      </p>
      <form method="post" action={actions('account-email')}>
        <input type="hidden" name="redirect" value={PROFILE} />
        <FormTable>
          <FormField
            label="New email address"
            htmlFor="profile-email"
            description="We’ll email it a link; your address changes once the link is used."
          >
            <input
              id="profile-email"
              type="email"
              name="email"
              className="regular-text"
              autoComplete="email"
              required
            />
          </FormField>
          <FormField label="Current password" htmlFor="profile-email-password">
            <input
              id="profile-email-password"
              type="password"
              name="password"
              className="regular-text"
              autoComplete="current-password"
              required
            />
          </FormField>
        </FormTable>
        <p className="submit">
          <Button type="submit">Send a confirmation link</Button>
        </p>
      </form>

      <h2>Password</h2>
      <form method="post" action={actions('account-password')}>
        <input type="hidden" name="redirect" value={PROFILE} />
        <FormTable>
          <FormField label="Current password" htmlFor="profile-current">
            <input
              id="profile-current"
              type="password"
              name="current"
              className="regular-text"
              autoComplete="current-password"
              required
            />
          </FormField>
          <FormField
            label="New password"
            htmlFor="profile-password"
            description={`At least ${MIN_PASSWORD_LENGTH} characters. Your other sessions will be logged out.`}
          >
            <input
              id="profile-password"
              type="password"
              name="password"
              className="regular-text"
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              required
            />
          </FormField>
        </FormTable>
        <p className="submit">
          <Button type="submit">Change Password</Button>
        </p>
      </form>

      <h2>Sessions</h2>
      <p>Signed in on another device, or left signed in somewhere public?</p>
      <FormButton action={actions('profile-sessions')}>Log Out Everywhere Else</FormButton>
      <Slot name="admin.profile" props={{ user }} />
    </AdminScreen>
  )
}
