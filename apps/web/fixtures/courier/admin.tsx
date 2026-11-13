import { Notice } from '@otwdesign/admin-ui'
import { defineAdmin } from '@otwdesign/sdk'
import courier from './index'

// Courier's section on the Library's settings page, and a notice for the people who can set its
// key while it isn't set.
export default defineAdmin(courier, (cms) => {
  cms.admin.settingsSection({
    name: 'courier',
    page: 'library.settings',
    title: 'Courier',
    description: 'Deliveries. The key comes from the server environment.',
    fields: ['courier.apiKey'],
  })

  // What a plugin adds to people's own Profile, and to the screen that edits someone else.
  cms.slots.fill('admin.profile', {
    component: ({ user }) => (
      <>
        <h2>Deliveries</h2>
        <p>Courier delivers to {user.email}.</p>
      </>
    ),
  })
  cms.slots.fill('admin.user', {
    component: ({ user, target }) => (
      <>
        <h2>Deliveries</h2>
        <p>
          {user.email} can see that Courier delivers to {target.email}.
        </p>
      </>
    ),
  })

  if (cms.settings.get('courier.apiKey')) return
  cms.slots.fill('admin.notices', {
    component: ({ user }) =>
      cms.auth.can(user, 'core.manage_settings') ? (
        <Notice type="warning">
          <p>
            Courier is active, but deliveries are off until <code>COURIER_API_KEY</code> is set on
            the server. <a href={cms.admin.url('library.settings')}>Library settings</a>
          </p>
        </Notice>
      ) : null,
  })
})
