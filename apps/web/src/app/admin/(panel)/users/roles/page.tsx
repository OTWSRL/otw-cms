import { ListTable } from '@cms/admin-ui'
import { ADMINISTRATOR } from '@cms/core'
import type { SearchParams } from '@cms/sdk'
import type { Metadata } from 'next'
import { AdminScreen } from '@/components/admin'
import { requireAdmin } from '@/cms/session'

export const metadata: Metadata = { title: 'Roles' }

/** What each role may do. Read-only: plugins define roles, so they follow plugin activation. */
export default async function RolesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [{ kernel }, params] = await Promise.all([
    requireAdmin('/admin/users/roles', 'core.manage_users'),
    searchParams,
  ])
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
