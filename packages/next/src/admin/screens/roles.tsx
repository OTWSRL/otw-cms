import { ListTable } from '@otwdesign/admin-ui'
import { ADMINISTRATOR } from '@otwdesign/core'
import { AdminScreen } from '../screen'
import type { ScreenContext } from './context'

/** What each role may do. Read-only: plugins define roles, so they follow plugin activation. */
export async function RolesScreen({ kernel, searchParams: params }: ScreenContext) {
  const capabilityLabel = new Map(kernel.capabilities().map((c) => [c.name, c.label]))

  return (
    <AdminScreen title="Roles" flash={kernel.readFlash(params.flash)}>
      <p>Plugins add roles and capabilities; they change when plugins are switched on or off.</p>
      <ListTable
        caption="Roles"
        rows={kernel.roles()}
        rowKey={(role) => role.id}
        empty="No roles."
        columns={[
          {
            key: 'role',
            label: 'Role',
            render: (role) => (
              <>
                <strong>{role.label}</strong> <code>{role.id}</code>
              </>
            ),
          },
          {
            key: 'capabilities',
            label: 'Can',
            render: (role) =>
              role.id === ADMINISTRATOR
                ? 'Everything'
                : role.capabilities.map((name) => capabilityLabel.get(name)).join(', ') ||
                  'Nothing in the admin',
          },
        ]}
      />
    </AdminScreen>
  )
}
