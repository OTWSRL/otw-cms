import { AdminIcon, Button, ListTable, TableNav, Views } from '@otw/admin-ui'
import { AdminScreen } from '../screen'
import type { ScreenContext } from './context'
import { firstParam } from '../../runtime/search-params'

/** users.php: filter by role, tick users and change their role in one go. */
export async function UsersScreen({ kernel, user: me, searchParams: params }: ScreenContext) {
  const [users, roles] = [await kernel.auth.listUsers(), kernel.roles()]
  const roleLabel = new Map(roles.map((role) => [role.id, role.label]))
  const filter = roles.find((role) => role.id === firstParam(params.role))?.id
  const shown = filter ? users.filter((user) => user.role === filter) : users
  const count = (role: string) => users.filter((user) => user.role === role).length

  return (
    <AdminScreen
      title="Users"
      titleAction={{ label: 'Add User', url: '/admin/users/new' }}
      flash={kernel.readFlash(params.flash)}
    >
      <Views
        label="Filter users by role"
        views={[
          { label: 'All', count: users.length, href: '/admin/users', current: !filter },
          ...roles
            .filter((role) => count(role.id) > 0)
            .map((role) => ({
              label: role.label,
              count: count(role.id),
              href: `/admin/users?role=${encodeURIComponent(role.id)}`,
              current: filter === role.id,
            })),
        ]}
      />
      <form method="post" action={kernel.actionUrl('core', 'set-role')}>
        <TableNav total={shown.length} noun={['item', 'items']}>
          <label className="screen-reader-text" htmlFor="new-role">
            Change role to…
          </label>
          <select id="new-role" name="role" defaultValue="">
            <option value="" disabled>
              Change role to…
            </option>
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.label}
              </option>
            ))}
          </select>
          <Button type="submit">Change</Button>
        </TableNav>
        <ListTable
          caption="Users"
          rows={shown}
          rowKey={(user) => user.id}
          select={{ name: 'users', value: (user) => user.id, label: (user) => user.email }}
          empty="No users found."
          columns={[
            {
              key: 'email',
              label: 'Email',
              render: (user) => (
                <span className="user-identity">
                  <span className="avatar avatar-list" aria-hidden="true">
                    <AdminIcon icon="users" />
                  </span>
                  <strong>
                    <a
                      className="row-title"
                      href={user.id === me.id ? '/admin/profile' : `/admin/users/${user.id}`}
                      aria-label={`Edit ${user.email}`}
                    >
                      {user.email}
                    </a>
                  </strong>
                  {user.id === me.id && <span className="description"> (you)</span>}
                </span>
              ),
            },
            { key: 'name', label: 'Name', render: (user) => user.name || '—' },
            {
              key: 'role',
              label: 'Role',
              // The plugin that defined it is inactive; the user has no capabilities.
              render: (user) => roleLabel.get(user.role) ?? `${user.role} (inactive)`,
            },
          ]}
        />
      </form>
    </AdminScreen>
  )
}
