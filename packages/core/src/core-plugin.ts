import type {
  CapabilityName,
  ContentTypeDefinition,
  MediaItem,
  PluginDefinition,
  RequiredCapabilities,
  TextSetting,
  SettingDefinitions,
  TaxonomyDefinition,
  User,
} from '@otwdesign/sdk'
import { ActionError } from '@otwdesign/sdk'
import { ADMIN_PREFIX, LOGIN_PATH, safeRedirectPath, type InternalAction } from './admin'
import { ACCOUNT_PATH } from './accounts'
import { AuthError, type AuthService } from './auth'
import { ADMINISTRATOR, READ, type CapabilityStore } from './capabilities'
import { coreMigrations } from './core-migrations'
import type { JobService } from './jobs'
import { WebhookError, type WebhookService } from './webhooks'
import type { WebhookStatus } from './core-schema'
import type { SettingsLayoutStore } from './settings-pages'
import { isPackageName, type AutoUpdateMode, type UpdateService } from './updates'
import { clearedSessionCookies, sessionCookie } from './session-cookie'
import { isMailbox } from './mail'
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

/** A side of an image size, in Settings › Media: 0 leaves it free, as in WordPress. */
function pixels(label: string, fallback: string): TextSetting {
  return {
    type: 'text',
    label,
    default: fallback,
    maxLength: 5,
    validate: (value) =>
      /^\d+$/.test(value) && Number(value) <= 10000
        ? null
        : 'Use a whole number of pixels from 0 to 10000',
  }
}

const coreSettings: SettingDefinitions = {
  'site.title': { type: 'text', label: 'Site title', default: 'My Site', maxLength: 100 },
  'site.url': {
    type: 'text',
    label: 'Site address',
    description:
      'Public origin used in links sent elsewhere, such as payment return pages. Leave empty to use the address each request arrives on.',
    env: 'SITE_URL',
    validate: validateOrigin,
  },
  'reading.show_on_front': {
    type: 'select',
    label: 'Your homepage displays',
    options: [
      { value: 'posts', label: 'Your latest posts' },
      { value: 'page', label: 'A static page (choose below)' },
    ],
    default: 'posts',
  },
  'reading.page_on_front': {
    type: 'entry',
    contentType: 'core.page',
    label: 'Homepage',
  },
  'reading.page_for_posts': {
    type: 'entry',
    contentType: 'core.page',
    label: 'Posts page',
    description: 'Lists the latest posts, while the homepage is a static page.',
  },
  'reading.posts_per_page': {
    type: 'text',
    label: 'Blog pages show at most',
    description: 'Posts, or entries of any archive, on each page of a list.',
    default: '10',
    maxLength: 3,
    validate: (value) =>
      /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 100
        ? null
        : 'Use a whole number from 1 to 100',
  },
  // Settings › Media, with WordPress's defaults.
  'media.thumbnail_size_w': pixels('Thumbnail width', '150'),
  'media.thumbnail_size_h': pixels('Thumbnail height', '150'),
  'media.thumbnail_crop': {
    type: 'boolean',
    label: 'Crop thumbnail to exact dimensions (normally thumbnails are proportional)',
    default: true,
  },
  'media.medium_size_w': pixels('Medium size max width', '300'),
  'media.medium_size_h': pixels('Medium size max height', '300'),
  'media.large_size_w': pixels('Large size max width', '1024'),
  'media.large_size_h': pixels('Large size max height', '1024'),
  'media.uploads_use_yearmonth_folders': {
    type: 'boolean',
    label: 'Organize my uploads into month- and year-based folders',
    default: true,
  },
  'mail.from': {
    type: 'text',
    label: 'Send email from',
    description:
      'Who the site’s email comes from, such as My Site <hello@example.com>. Leave it empty to use the mail plugin’s own sender.',
    env: 'MAIL_FROM',
    maxLength: 320,
    validate: (value) =>
      value === '' || isMailbox(value)
        ? null
        : 'Use an address, such as My Site <hello@example.com>',
  },
  'users.can_register': {
    type: 'boolean',
    label: 'Anyone can register',
    description:
      'People sign up at /account as Customers, with a link emailed to set their password. Needs a mail plugin.',
    default: false,
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
  // WordPress's content roles. What each may do with posts and pages comes from those types.
  const content = [
    ['editor', 'Editor'],
    ['author', 'Author'],
    ['contributor', 'Contributor'],
  ] as const
  for (const [id, label] of content) {
    capabilities.role(CORE, id, { label, capabilities: ['core.access_admin'] })
  }
  capabilities.role(CORE, 'customer', { label: 'Customer' })
  capabilities.capability(CORE, READ, { label: 'Read published content' })
  capabilities.capability(CORE, 'core.access_admin', { label: 'Use the admin' })
  capabilities.capability(CORE, 'core.manage_plugins', { label: 'Activate and deactivate plugins' })
  capabilities.capability(CORE, 'core.manage_settings', { label: 'Change settings' })
  capabilities.capability(CORE, 'core.manage_users', { label: 'Add users and change roles' })
  // No role gets it: updating rebuilds the site, so it stays with administrators unless granted.
  capabilities.capability(CORE, 'core.manage_updates', { label: 'Update the CMS and plugins' })
  // Nor this: a plugin is code that runs on the server.
  capabilities.capability(CORE, 'core.install_plugins', { label: 'Add and remove plugins' })
  // Nor this: a webhook sends the site's data to an address of the holder's choosing.
  capabilities.capability(CORE, 'core.manage_webhooks', { label: 'Manage webhooks' })
  // No role gets it either: the queue shows every plugin's jobs and what they were given.
  capabilities.capability(CORE, 'core.manage_jobs', { label: 'Run and cancel scheduled actions' })
  // WordPress's upload_files: authors and editors; contributors write without uploading.
  capabilities.capability(CORE, 'core.upload_files', { label: 'Upload files' })
  capabilities.grant(CORE, 'editor', ['core.upload_files'])
  capabilities.grant(CORE, 'author', ['core.upload_files'])
  // Media are checked as WordPress checks attachments, by posts' capabilities: one's own file
  // with edit_posts or delete_posts, anyone else's with edit_others_posts or delete_others_posts.
  const mediaChange =
    (own: CapabilityName, others: CapabilityName) =>
    (user: User, ...args: unknown[]): RequiredCapabilities => {
      const item = args[0] as MediaItem | undefined
      if (!item || typeof item !== 'object') return false
      return item.authorId !== null && item.authorId === user.id ? [own] : [others]
    }
  capabilities.metaCapability(CORE, 'core.edit_media', {
    label: 'Media: edit',
    map: mediaChange('core.edit_posts', 'core.edit_others_posts'),
  })
  capabilities.metaCapability(CORE, 'core.delete_media', {
    label: 'Media: delete',
    map: mediaChange('core.delete_posts', 'core.delete_others_posts'),
  })
}

/** WordPress's posts and pages. Authors and contributors write posts; pages are editors'. */
export function registerCoreContent(types: {
  register(pluginId: string, name: string, definition: ContentTypeDefinition): unknown
  taxonomy?(pluginId: string, name: string, definition: TaxonomyDefinition): unknown
}): void {
  types.register(CORE, 'post', {
    labels: { singular: 'Post', plural: 'Posts' },
    public: true,
    supports: ['title', 'body', 'excerpt', 'author', 'revisions', 'thumbnail'],
  })
  types.register(CORE, 'page', {
    labels: { singular: 'Page', plural: 'Pages' },
    public: true,
    hierarchical: true,
    supports: ['title', 'body', 'author', 'position', 'revisions', 'thumbnail'],
    roles: { editor: 'editor' },
  })
  // WordPress's categories and tags, with its capability names: core.manage_categories…
  types.taxonomy?.(CORE, 'category', {
    labels: { singular: 'Category', plural: 'Categories' },
    plural: 'categories',
    types: ['core.post'],
    hierarchical: true,
    showAdminColumn: true,
    defaultTerm: { name: 'Uncategorized' },
  })
  types.taxonomy?.(CORE, 'tag', {
    labels: { singular: 'Tag', plural: 'Tags' },
    types: ['core.post'],
    showAdminColumn: true,
  })
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
  layout.section(CORE, {
    name: 'email',
    page: 'core.general',
    title: 'Email',
    fields: ['mail.from'],
  })
  layout.section(CORE, {
    name: 'membership',
    page: 'core.general',
    title: 'Membership',
    fields: ['users.can_register'],
  })
  // WordPress's Settings › Reading.
  layout.page(
    CORE,
    {
      name: 'reading',
      path: '/reading',
      title: 'Reading Settings',
      menu: { label: 'Reading', order: 1 },
    },
    `${ADMIN_PREFIX}/settings/reading`,
  )
  layout.section(CORE, {
    name: 'reading',
    page: 'core.reading',
    title: 'Reading',
    fields: [
      'reading.show_on_front',
      'reading.page_on_front',
      'reading.page_for_posts',
      'reading.posts_per_page',
    ],
  })
  // WordPress's Settings › Media.
  layout.page(
    CORE,
    { name: 'media', path: '/media', title: 'Media Settings', menu: { label: 'Media', order: 2 } },
    `${ADMIN_PREFIX}/settings/media`,
  )
  layout.section(CORE, {
    name: 'image-sizes',
    page: 'core.media',
    title: 'Image sizes',
    description:
      'The sizes listed below determine the maximum dimensions in pixels to use when adding an image to the Media Library.',
    fields: [
      'media.thumbnail_size_w',
      'media.thumbnail_size_h',
      'media.thumbnail_crop',
      'media.medium_size_w',
      'media.medium_size_h',
      'media.large_size_w',
      'media.large_size_h',
    ],
  })
  layout.section(CORE, {
    name: 'uploads',
    page: 'core.media',
    title: 'Uploading Files',
    fields: ['media.uploads_use_yearmonth_folders'],
  })
}

export interface CoreActionDependencies {
  auth: AuthService
  /** Whether the user may use the admin; others sign in to their account on the site instead. */
  canUseAdmin(user: User): boolean
  /** Whether the user may activate, deactivate and delete the data of plugins. */
  canManagePlugins(user: User): boolean
  /** Each returns the notice to show. */
  activate(pluginId: string): Promise<string>
  deactivate(pluginId: string): Promise<string>
  /** Deletes an inactive plugin's data. */
  uninstall(pluginId: string): Promise<string>
  /** Runs pending migrations for core and the active plugins. */
  updateDatabase(): Promise<string>
  /** The site's way of applying updates, when it has one. */
  updates: UpdateService | null
  /** Checks the page's own capability, which may be a plugin's rather than core's. */
  saveSettings(page: string, user: User, form: FormData): Promise<void>
  /** Tools › Scheduled Actions: each says whether the job was one it could act on. */
  jobs: Pick<JobService, 'runNow' | 'cancelOne'>
  /** Settings › Webhooks. */
  webhooks: Pick<WebhookService, 'create' | 'update' | 'delete' | 'test'>
}

function field(form: FormData, name: string): string {
  const value = form.get(name)
  return typeof value === 'string' ? value : ''
}

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The job a form names, checked before it reaches a uuid column. */
function jobId(form: FormData): string {
  const id = field(form, 'id')
  if (!JOB_ID.test(id)) throw new ActionError('That action no longer exists.')
  return id
}

/** Settings › Webhooks, as WooCommerce has its webhooks under its settings. */
export const WEBHOOKS_PATH = `${ADMIN_PREFIX}/settings/webhooks`

async function asWebhookError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof WebhookError) throw new ActionError(error.message)
    throw error
  }
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
        const { user, token } = await asActionError(() =>
          auth.signIn(field(form, 'email'), field(form, 'password')),
        )
        const next = safeRedirectPath(field(form, 'next')) ?? ADMIN_PREFIX
        const admin = next === ADMIN_PREFIX || next.startsWith(`${ADMIN_PREFIX}/`)
        return {
          // A customer at the admin's sign-in goes to their account, as WordPress sends a
          // subscriber to their profile, rather than to a screen they may not open.
          redirect: admin && !deps.canUseAdmin(user) ? ACCOUNT_PATH : next,
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
      // WordPress's Delete: the plugin's data, then its package, which takes a rebuild.
      name: 'delete-plugin',
      capability: 'core.install_plugins',
      async handler({ form, user }) {
        const name = packageField(form)
        if (!deps.updates?.remove) throw new ActionError(NO_INSTALL)
        if (!user || !deps.canManagePlugins(user)) {
          throw new ActionError('Deleting a plugin also takes the capability to manage plugins.')
        }
        // The data first, in its transaction: if that fails, the package stays too.
        const deleted = await deps.uninstall(field(form, 'plugin'))
        let removing: string
        try {
          removing = await deps.updates.remove(name)
        } catch (error) {
          // Half done, and said so: the data is gone, the package can be removed again later.
          throw new ActionError(
            `${deleted} The plugin itself wasn’t removed: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
        return { redirect: `${ADMIN_PREFIX}/plugins`, notice: `${deleted} ${removing}` }
      },
    },
    {
      // WordPress's Delete, for the plugin's data: its package stays installed.
      name: 'delete-plugin-data',
      capability: 'core.manage_plugins',
      handler: async ({ form }) => ({
        redirect: `${ADMIN_PREFIX}/plugins`,
        notice: await deps.uninstall(field(form, 'plugin')),
      }),
    },
    ...updateActions(deps.updates),
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
      // WooCommerce's webhook form: Add when it names no webhook, Save when it does.
      name: 'save-webhook',
      capability: 'core.manage_webhooks',
      async handler({ form }) {
        const id = field(form, 'id')
        const input = {
          name: field(form, 'name'),
          url: field(form, 'url'),
          topics: form.getAll('topics').filter((value) => typeof value === 'string'),
          status: field(form, 'status') as WebhookStatus,
          newSecret: field(form, 'new_secret') !== '',
        }
        const saved = await asWebhookError(() =>
          id ? deps.webhooks.update(id, input) : deps.webhooks.create(input),
        )
        return {
          redirect: `${WEBHOOKS_PATH}?edit=${saved.id}`,
          notice: id ? 'Webhook updated.' : 'Webhook added.',
        }
      },
    },
    {
      name: 'delete-webhook',
      capability: 'core.manage_webhooks',
      async handler({ form }) {
        if (!(await deps.webhooks.delete(field(form, 'id')))) {
          throw new ActionError('That webhook no longer exists.')
        }
        return { redirect: WEBHOOKS_PATH, notice: 'Webhook deleted.' }
      },
    },
    {
      name: 'test-webhook',
      capability: 'core.manage_webhooks',
      async handler({ form }) {
        if (!(await deps.webhooks.test(field(form, 'id')))) {
          throw new ActionError('That webhook no longer exists.')
        }
        return { notice: 'A test delivery is on its way. Its result shows here once it has run.' }
      },
    },
    {
      name: 'run-job',
      capability: 'core.manage_jobs',
      async handler({ form }) {
        if (!(await deps.jobs.runNow(jobId(form)))) {
          throw new ActionError('Only a waiting or failed action can be run.')
        }
        return { notice: 'The action runs now.' }
      },
    },
    {
      name: 'cancel-job',
      capability: 'core.manage_jobs',
      async handler({ form }) {
        if (!(await deps.jobs.cancelOne(jobId(form)))) {
          throw new ActionError('Only a waiting action can be cancelled.')
        }
        return { notice: 'Action cancelled.' }
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

const NO_INSTALL =
  'Adding and removing plugins from the admin needs the site to run under `cms serve`, or a GitHub repository. Run `cms plugin add` or `cms plugin remove` where the site is built instead.'

/** The package a form names: an npm package's name and nothing else. */
function packageField(form: FormData): string {
  const name = field(form, 'package').trim()
  if (!isPackageName(name)) {
    throw new ActionError(
      'Use the plugin’s package name on npm, such as @acme/forum: no version, address or path.',
    )
  }
  return name
}

const NO_UPDATES =
  'Updates from the admin need the site to run under `cms serve`, or a GitHub repository. Run `cms update` on the server instead.'

/** Dashboard › Updates: each hands the request to the site's update service. */
function updateActions(updates: UpdateService | null): InternalAction[] {
  const service = (): UpdateService => {
    if (!updates) throw new ActionError(NO_UPDATES)
    return updates
  }
  return [
    {
      // WordPress's Install Now: the plugin's package is added and the site rebuilt.
      name: 'install-plugin',
      capability: 'core.install_plugins',
      async handler({ form }) {
        const name = packageField(form)
        if (!updates?.install) throw new ActionError(NO_INSTALL)
        return { notice: await updates.install(name) }
      },
    },
    {
      name: 'check-updates',
      capability: 'core.manage_updates',
      handler: async () => ({ notice: await service().check() }),
    },
    {
      name: 'update',
      capability: 'core.manage_updates',
      async handler({ form }) {
        const packages = form.getAll('packages').filter((value) => typeof value === 'string')
        const request =
          packages.length > 0
            ? { packages }
            : field(form, 'scope') === 'plugins'
              ? { pluginsOnly: true }
              : {}
        return { notice: await service().update(request) }
      },
    },
    {
      name: 'rollback-release',
      capability: 'core.manage_updates',
      handler: async ({ form }) => ({ notice: await service().rollback(field(form, 'release')) }),
    },
    {
      name: 'auto-updates',
      capability: 'core.manage_updates',
      async handler({ form }) {
        const mode = field(form, 'mode')
        if (mode !== 'off' && mode !== 'patch') {
          throw new ActionError('Choose off or patch releases.')
        }
        return { notice: await service().setAutoUpdate(mode satisfies AutoUpdateMode) }
      },
    },
  ]
}
