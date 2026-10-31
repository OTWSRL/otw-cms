import type { PluginDefinition, SettingDefinitions, User } from '@cms/sdk'
import { ActionError } from '@cms/sdk'
import { ADMIN_PREFIX, LOGIN_PATH, safeRedirectPath, type InternalAction } from './admin'
import { AuthError, type AuthService } from './auth'
import { ADMINISTRATOR, type CapabilityStore } from './capabilities'
import { coreMigrations } from './core-migrations'
import type { SettingsLayoutStore } from './settings-pages'
import { clearedSessionCookies, sessionCookie } from './session-cookie'
import { CORE_VERSION } from './version'

export const CORE = 'core'

function validateOrigin(value: string): string | null {
  try {
    const url = new URL(value)
    const bare = url.pathname === '/' && !url.search && !url.hash
    if ((url.protocol === 'https:' || url.protocol === 'http:') && bare) return null
  } catch {
    // Falls through to the message below.
  }
  return 'Use an address such as https://example.com'
}

function validateLocale(value: string): string | null {
  try {
    Intl.getCanonicalLocales(value)
    return null
  } catch {
    return 'Use a language tag such as en-US'
  }
}

const coreSettings: SettingDefinitions = {
  'site.title': { type: 'text', label: 'Site title', default: 'Next CMS', maxLength: 100 },
  'site.url': {
    type: 'text',
    label: 'Site address',
    description:
      'Public origin used in links sent elsewhere, such as payment return pages. Leave empty to use the address each request arrives on.',
    env: 'SITE_URL',
    validate: validateOrigin,
  },
  'site.locale': {
    type: 'text',
    label: 'Locale',
    description: 'Formats numbers and prices, such as en-US or de-DE.',
    default: 'en-US',
    env: 'SITE_LOCALE',
    maxLength: 35,
    validate: validateLocale,
  },
}

/** Core takes part in migrations and settings like a plugin, but always loads first. */
export const coreDefinition: PluginDefinition = {
  id: CORE,
  version: CORE_VERSION,
  name: 'General',
  migrations: coreMigrations,
  settings: coreSettings,
}

export function registerCoreCapabilities(capabilities: CapabilityStore): void {
  capabilities.role(CORE, ADMINISTRATOR, { label: 'Administrator' })
  capabilities.role(CORE, 'customer', { label: 'Customer' })
  capabilities.capability(CORE, 'core.access_admin', { label: 'Use the admin' })
  capabilities.capability(CORE, 'core.manage_plugins', { label: 'Activate and deactivate plugins' })
  capabilities.capability(CORE, 'core.manage_settings', { label: 'Change settings' })
  capabilities.capability(CORE, 'core.manage_users', { label: 'Add users and change roles' })
}

/** WordPress's Settings › General, which other plugins add sections and fields to. */
export function registerCoreSettings(layout: SettingsLayoutStore): void {
  layout.page(
    CORE,
    { name: 'general', path: '/', title: 'General settings', menu: { label: 'General', order: 0 } },
    `${ADMIN_PREFIX}/settings`,
  )
  layout.section(CORE, {
    name: 'site',
    page: 'core.general',
    title: 'Site',
    fields: ['site.title', 'site.url', 'site.locale'],
  })
}

export interface CoreActionDependencies {
  auth: AuthService
  /** Each returns the notice to show. */
  activate(pluginId: string): Promise<string>
  deactivate(pluginId: string): Promise<string>
  /** Runs pending migrations for core and the active plugins. */
  updateDatabase(): Promise<string>
  /** Checks the page's own capability, which may be a plugin's rather than core's. */
  saveSettings(page: string, user: User, form: FormData): Promise<void>
}

function field(form: FormData, name: string): string {
  const value = form.get(name)
  return typeof value === 'string' ? value : ''
}

async function asActionError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof AuthError) throw new ActionError(error.message)
    throw error
  }
}

export function coreActions(deps: CoreActionDependencies): InternalAction[] {
  const { auth } = deps
  return [
    {
      name: 'login',
      capability: null,
      async handler({ form, secure }) {
        const { token } = await asActionError(() =>
          auth.signIn(field(form, 'email'), field(form, 'password')),
        )
        return {
          redirect: safeRedirectPath(field(form, 'next')) ?? ADMIN_PREFIX,
          cookies: [sessionCookie(token, secure)],
        }
      },
    },
    {
      name: 'logout',
      capability: null,
      async handler({ sessionToken }) {
        await auth.signOut(sessionToken)
        return {
          redirect: LOGIN_PATH,
          notice: 'You are signed out.',
          cookies: clearedSessionCookies(),
        }
      },
    },
    {
      name: 'setup',
      capability: null,
      async handler({ form, secure }) {
        const user = await asActionError(() =>
          auth.createFirstAdministrator({
            email: field(form, 'email'),
            name: field(form, 'name'),
            password: field(form, 'password'),
          }),
        )
        return {
          redirect: ADMIN_PREFIX,
          notice: 'Your site is ready.',
          cookies: [sessionCookie(await auth.createSession(user.id), secure)],
        }
      },
    },
    {
      name: 'activate-plugin',
      capability: 'core.manage_plugins',
      handler: async ({ form }) => ({ notice: await deps.activate(field(form, 'plugin')) }),
    },
    {
      name: 'deactivate-plugin',
      capability: 'core.manage_plugins',
      handler: async ({ form }) => ({ notice: await deps.deactivate(field(form, 'plugin')) }),
    },
    {
      // WooCommerce's "Update database" button, for sites that migrate at deploy.
      name: 'update-database',
      capability: 'core.manage_plugins',
      handler: async () => ({ notice: await deps.updateDatabase() }),
    },
    {
      name: 'save-settings',
      capability: 'core.access_admin',
      async handler({ form, user }) {
        await deps.saveSettings(field(form, 'page'), user!, form)
        return { notice: 'Settings saved.' }
      },
    },
    {
      name: 'create-user',
      capability: 'core.manage_users',
      async handler({ form }) {
        const user = await asActionError(() =>
          auth.createUser({
            email: field(form, 'email'),
            name: field(form, 'name'),
            role: field(form, 'role'),
            password: field(form, 'password'),
          }),
        )
        return { redirect: '/admin/users', notice: `Added ${user.email}.` }
      },
    },
    {
      name: 'set-role',
      capability: 'core.manage_users',
      async handler({ form }) {
        const ids = form.getAll('users').filter((value) => typeof value === 'string')
        if (ids.length === 0) throw new ActionError('Select the users to change.')
        if (!field(form, 'role')) throw new ActionError('Choose the role to change them to.')
        const updated = await asActionError(() => auth.setRoles(ids, field(form, 'role')))
        return {
          notice:
            updated.length === 1
              ? `Updated ${updated[0]!.email}.`
              : `Changed the role of ${updated.length} users.`,
        }
      },
    },
  ]
}
