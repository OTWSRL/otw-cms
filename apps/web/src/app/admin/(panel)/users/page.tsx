import { ADMINISTRATOR, MIN_PASSWORD_LENGTH } from '@cms/core'
import type { SearchParams } from '@cms/sdk'
import type { Metadata } from 'next'
import { AdminScreen } from '@/components/admin'
import { requireAdmin } from '@/cms/session'

export const metadata: Metadata = { title: 'Users' }

export default async function UsersPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [{ kernel, user: me }, params] = await Promise.all([
    requireAdmin('/admin/users', 'core.manage_users'),
    searchParams,
  ])
  const [users, roles] = [await kernel.auth.listUsers(), kernel.roles()]
  const roleLabel = new Map(roles.map((role) => [role.id, role.label]))
  const capabilityLabel = new Map(kernel.capabilities().map((c) => [c.name, c.label]))
  const setRoleUrl = kernel.actionUrl('core', 'set-role')

  return (
    <AdminScreen title="Users" flash={kernel.readFlash(params.flash)}>
      <table className="cms-table">
        <thead>
          <tr>
            <th scope="col">Email</th>
            <th scope="col">Name</th>
            <th scope="col">Role</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id}>
              <td>
                {user.email}
                {user.id === me.id && <small> (you)</small>}
              </td>
              <td>{user.name}</td>
              <td>
                <form method="post" action={setRoleUrl} className="cms-inline-form">
                  <input type="hidden" name="user" value={user.id} />
                  <select
                    name="role"
                    defaultValue={user.role}
                    aria-label={`Role for ${user.email}`}
                  >
                    {!roleLabel.has(user.role) && (
                      // The plugin that defined it is inactive; the user has no capabilities.
                      <option value={user.role}>{user.role} (inactive)</option>
                    )}
                    {roles.map((role) => (
                      <option key={role.id} value={role.id}>
                        {role.label}
                      </option>
                    ))}
                  </select>
                  <button type="submit" className="cms-button">
                    Save<span className="cms-visually-hidden"> role for {user.email}</span>
                  </button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <section aria-labelledby="add-user" className="cms-section">
        <h2 id="add-user">Add user</h2>
        <form method="post" action={kernel.actionUrl('core', 'create-user')} className="cms-form">
          <label>
            Email
            <input type="email" name="email" autoComplete="off" required />
          </label>
          <label>
            Name
            <input name="name" autoComplete="off" maxLength={100} />
          </label>
          <label>
            Role
            <select name="role" defaultValue="customer">
              {roles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Password
            <input
              type="password"
              name="password"
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              required
            />
          </label>
          <button type="submit" className="cms-button">
            Add user
          </button>
        </form>
      </section>

      <section aria-labelledby="roles" className="cms-section">
        <h2 id="roles">Roles</h2>
        <p>Plugins add roles and capabilities; they change when plugins are switched on or off.</p>
        <table className="cms-table">
          <thead>
            <tr>
              <th scope="col">Role</th>
              <th scope="col">Can</th>
            </tr>
          </thead>
          <tbody>
            {roles.map((role) => (
              <tr key={role.id}>
                <th scope="row">{role.label}</th>
                <td>
                  {role.id === ADMINISTRATOR
                    ? 'Everything'
                    : role.capabilities.map((name) => capabilityLabel.get(name)).join(', ') ||
                      'Nothing in the admin'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </AdminScreen>
  )
}
