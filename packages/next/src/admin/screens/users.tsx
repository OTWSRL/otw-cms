import { AdminIcon, Button, ListTable, TableNav, Views } from '@otwdesign/admin-ui'
import { AdminScreen } from '../screen'
import type { ScreenContext } from './context'
import { firstParam } from '../../runtime/search-params'

/** WordPress's `users_per_page`. */
const PER_PAGE = 20

/**
 * users.php: filter by role, search, tick users and change their role in one go. A page of users
 * at a time, and the role counts from one grouped query, so a shop with a hundred thousand
 * customers lists as fast as a blog with three authors.
 */
export async function UsersScreen({ kernel, user: me, searchParams: params }: ScreenContext) {
  const roles = kernel.roles()
  const roleLabel = new Map(roles.map((role) => [role.id, role.label]))
  const filter = roles.find((role) => role.id === firstParam(params.role))?.id
  const search = (firstParam(params.s) ?? '').trim().slice(0, 100)
  const requested = Number(firstParam(params.paged) ?? 1)
  const page = Number.isSafeInteger(requested) && requested > 0 ? requested : 1
  const [{ users: shown, total }, counts] = await Promise.all([
    kernel.auth.findUsers({
      role: filter,
      search,
      limit: PER_PAGE,
      offset: (page - 1) * PER_PAGE,
    }),
    kernel.auth.countUsersByRole(),
  ])
  const count = (role: string) => counts[role] ?? 0
  const everyone = Object.values(counts).reduce((sum, n) => sum + n, 0)
  const listUrl = (changes: { role?: string | null; paged?: number }) => {
    const query = new URLSearchParams()
    const role = changes.role === undefined ? filter : changes.role
    if (role) query.set('role', role)
    if (search) query.set('s', search)
    if (changes.paged && changes.paged > 1) query.set('paged', String(changes.paged))
    const text = query.toString()
    return text ? `/admin/users?${text}` : '/admin/users'
  }

  return (
    <AdminScreen
      title="Users"
      titleAction={{ label: 'Add User', url: '/admin/users/new' }}
      flash={kernel.readFlash(params.flash)}
    >
      <Views
        label="Filter users by role"
        views={[
          { label: 'All', count: everyone, href: listUrl({ role: null }), current: !filter },
          ...roles
            .filter((role) => count(role.id) > 0)
            .map((role) => ({
              label: role.label,
              count: count(role.id),
              href: listUrl({ role: role.id }),
              current: filter === role.id,
            })),
        ]}
      />
      <form method="get" action="/admin/users" className="search-form">
        {filter && <input type="hidden" name="role" value={filter} />}
        <p className="search-box">
          <label className="screen-reader-text" htmlFor="user-search">
            Search Users
          </label>
          <input type="search" id="user-search" name="s" defaultValue={search} />
          <Button type="submit">Search Users</Button>
        </p>
      </form>
      <form method="post" action={kernel.actionUrl('core', 'set-role')}>
        <TableNav
          total={total}
          noun={['item', 'items']}
          page={page}
          pages={Math.max(1, Math.ceil(total / PER_PAGE))}
          pageUrl={(paged) => listUrl({ paged })}
        >
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
