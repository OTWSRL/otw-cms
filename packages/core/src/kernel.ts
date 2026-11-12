import type {
  ActionName,
  Actions,
  AdminDefinition,
  AdminPage,
  ApiRoute,
  CacheApi,
  CacheStore,
  CapabilityArgs,
  CapabilityName,
  ContentTemplate,
  ContentTypeDefinition,
  ContentView,
  MailTransport,
  MediaStorage,
  Database,
  TaxonomyDefinition,
  FilterContext,
  FilterName,
  FilterValue,
  HooksApi,
  Logger,
  MetaCapabilityName,
  PageMetadata,
  PageContext,
  PageProps,
  PageRoute,
  PluginContext,
  PluginDefinition,
  RegistryName,
  RegistryOf,
  SearchParams,
  ServiceName,
  Services,
  SettingName,
  Settings,
  SettingsPage,
  SettingsValues,
  SlotComponent,
  SlotName,
  User,
} from '@otwdesign/sdk'
import { ActionError, ForbiddenError, PageRedirect } from '@otwdesign/sdk'
import {
  actionPath,
  ADMIN_PREFIX,
  adminPath,
  createActionHandler,
  type AdminPageEntry,
  type AdminResolution,
  type ContentScreen,
  type MediaScreen,
  type InternalAction,
  type SettingsResolution,
} from './admin'
import { resolve as resolvePath } from 'node:path'
import { AdminMenu, type AdminMenuSection } from './admin-menu'
import { apiPath, dispatchApi, HTTP_METHODS, type ApiEntry } from './api'
import { createAuthService, type AuthService } from './auth'
import { DEFAULT_BRAND, type Brand } from './brand'
import { CapabilityStore, type CapabilityInfo, type RoleInfo } from './capabilities'
import { createContentService, type ContentService } from './content'
import { coreImageSizes, createMediaService, ImageSizeStore, type MediaService } from './media'
import { MEDIA_PATH, mediaActions, mediaListRoute, mediaUploadRoute } from './media-actions'
import { serveUpload } from './media-serve'
import { createCacheService, createMemoryCache, type MemoryCache } from './cache'
import { registerCoreEvents } from './core-events'
import { registerCoreJobs } from './core-jobs'
import { createJobService, cronHandler, JobStore, type JobService } from './jobs'
import { createMailService, type MailService } from './mail'
import { createWebhookService, EventStore, type WebhookService } from './webhooks'
import { accountActions } from './account-actions'
import { createAccountPages, type AccountResolution } from './account-pages'
import { createAccountService, signInUrl, type AccountService } from './accounts'
import { createUsersService, UserMetaStore, type UsersService } from './users'
import { userActions } from './user-actions'
import { localStorage, UPLOADS_PATH } from './media-storage'
import { contentActions } from './content-actions'
import { ContentScreenStore, type ContentScreenExtensions } from './content-screens'
import { MetaStore } from './content-meta'
import { ContentRoutes } from './content-routes'
import { TemplateStore } from './content-templates'
import { createSiteContent, type ContentResolution } from './site-content'
import { ContentTypeStore } from './content-types'
import { TaxonomyStore } from './taxonomies'
import { createTermService } from './terms'
import {
  CORE,
  coreActions,
  coreDefinition,
  registerCoreCapabilities,
  registerCoreContent,
  registerCoreSettings,
} from './core-plugin'
import { DatabaseContext } from './database'
import { PluginBootError } from './errors'
import { createFlashCodec, type Flash, type FlashCodec } from './flash'
import { HookBus } from './hooks'
import { consoleLogger, withContext } from './logger'
import { pendingMigrations, runMigrations } from './migrations'
import type { OriginPolicy } from './origins'
import { DatabaseUpdateRequiredError, migrateSite } from './site-migrations'
import type { UpdateService } from './updates'
import {
  bumpGeneration,
  ensureSecret,
  readBootState,
  readGeneration,
  type WebhookTopics,
} from './options'
import type { HashCost } from './passwords'
import {
  activationBlockers,
  deactivationBlockers,
  displayName,
  loadActiveIds,
  saveActive,
} from './plugin-state'
import { RegistryStore } from './registries'
import { resolvePlugins, type Resolution, type SkippedPlugin } from './resolver'
import { fillPattern, paramNames, parsePattern, Router } from './router'
import { ServiceStore } from './services'
import {
  declaredSettings,
  loadStoredSettings,
  resolveSettings,
  saveSettings,
  type Env,
  type ResolvedSetting,
  type SettingValue,
} from './settings'
import {
  pageUpdates,
  pageView,
  SettingsLayoutStore,
  type ResolvedSettingsPage,
} from './settings-pages'
import { SlotStore } from './slots'
import { currentTraceId, traced, type TraceCollector } from './tracing'
import { CORE_VERSION } from './version'

export interface KernelOptions {
  /** Every installed plugin (from the generated import map). */
  plugins: readonly PluginDefinition[]
  /**
   * The plugins' admin entries, where the app shows the admin (its screens and API routes).
   * Leave it out where visitors are, so admin components never reach them.
   */
  admin?: readonly AdminDefinition[]
  /**
   * Pins the active plugins and turns off activation in the admin (tests, or sites that manage
   * plugins in configuration). Without it, activation lives in the database; on first boot every
   * installed plugin is active.
   */
  active?: readonly string[]
  db: Database
  /** Environment variables, for settings that declare an `env` override. */
  env?: Env
  /** Fixed values that win over the environment and the database (tests, embedding). */
  settings?: SettingsValues
  /** Page route path overrides, e.g. `{ 'commerce.product': '/p/:slug' }`. */
  routes?: Readonly<Record<string, string>>
  /** Extra origins allowed to send unsafe API requests. */
  allowedOrigins?: readonly string[]
  /**
   * A reverse proxy the site trusts sits in front (cms serve sets this): take the visitor's
   * origin from X-Forwarded-Host and X-Forwarded-Proto.
   */
  trustProxy?: boolean
  logger?: Logger
  /** Throw when a plugin fails to boot instead of booting without it. Use in tests and CI. */
  strict?: boolean
  coreVersion?: string
  /** Signs flash messages. Defaults to a random secret stored in the database. */
  secret?: string
  /** Runs after the admin changes activation or settings, so the app can reboot its kernel. */
  onChange?: () => void
  /**
   * Runs when a job has been queued and its transaction committed, with the time it's due, so
   * the app can wake what runs its jobs (`kernel.jobs.runDue()`).
   */
  onJobQueued?: (dueAt: Date) => void
  /** What sends webhook deliveries. Defaults to the global `fetch`; tests give their own. */
  fetch?: typeof fetch
  /**
   * This server's cached values (`createMemoryCache()`), for the app to share between its
   * kernels, so what one deletes is gone for the others. Without it, the kernel has its own.
   */
  cacheMemory?: MemoryCache
  /** `fast` lowers the password hashing cost. Only for test suites. */
  passwordHashing?: HashCost
  /**
   * `startup` (default) applies pending migrations when the site boots. `deploy` never does: run
   * `cms migrate` when deploying. Until then plugins with pending migrations stay off, and pending
   * core migrations stop the boot with `DatabaseUpdateRequiredError`.
   */
  migrations?: 'startup' | 'deploy'
  /** How this site applies updates from the admin (Dashboard › Updates), if it can. */
  updates?: UpdateService
  /** The name the admin shows for the CMS. Defaults to DEFAULT_BRAND. */
  brand?: Brand
  /**
   * Collects request traces, when the site loads the CMS's instrumentation. A plugin that calls
   * `cms.traces.enable()` turns recording on.
   */
  traces?: TraceCollector
  /**
   * Where uploads are kept on disk unless a plugin provides storage (default `.data/uploads`), and
   * the largest file one upload may be (default 64 MB).
   */
  uploads?: { dir?: string; maxBytes?: number }
}

export interface ResolvedPage {
  key: string
  pluginId: string
  props: PageProps<unknown>
  Component: PageRoute<unknown>['component']
  metadata(): Promise<PageMetadata>
}

export interface PluginStatus {
  id: string
  name: string
  version: string
  description?: string
  requires: Readonly<Record<string, string>>
  /** `failed`: switched on, but it (or something it needs) didn't load. */
  status: 'active' | 'inactive' | 'failed'
  reason?: string
  /** Why it can't be activated (when inactive) or deactivated (when on) right now. */
  blockers: string[]
}

export interface Kernel {
  readonly coreVersion: string
  readonly brand: Brand
  /** Loaded plugin ids, in load order. */
  readonly active: readonly string[]
  readonly skipped: readonly SkippedPlugin[]
  /** Plugins kept off because their migrations haven't run (`migrations: 'deploy'`). */
  readonly databaseUpdates: readonly string[]
  /** The site's update service, for Dashboard › Updates; `null` when it has none. */
  readonly updates: UpdateService | null
  readonly warnings: readonly string[]
  readonly db: Database
  /** Changes when the admin changes activation or settings. */
  readonly generation: number
  /** `pinned` when the active set comes from configuration rather than the admin. */
  readonly activation: 'database' | 'pinned'
  /** False once activation or settings changed after this kernel booted. */
  isCurrent(): Promise<boolean>
  isActive(pluginId: string): boolean
  transaction<T>(fn: (db: Database) => Promise<T>): Promise<T>
  applyFilters<K extends FilterName>(
    name: K,
    value: FilterValue<K>,
    context: FilterContext<K>,
  ): Promise<FilterValue<K>>
  doAction<K extends ActionName>(name: K, payload: Actions[K]): Promise<void>
  service<K extends ServiceName>(name: K): Services[K]
  registry<K extends RegistryName>(name: K): RegistryOf<K>
  setting<K extends SettingName>(key: K): Settings[K] | undefined
  url(name: string, params?: Record<string, string>): string
  /**
   * Matches a page route and runs its loader. `null` means 404. `user` looks up who's asking,
   * when the page asks; without it, nobody is signed in. A loader may throw `PageRedirect` (as
   * `requireUser()` does for a signed-out visitor) or `ForbiddenError`, for the caller to answer.
   */
  resolvePage(
    pathname: string,
    searchParams?: SearchParams,
    options?: { user?: () => Promise<User | null> },
  ): Promise<ResolvedPage | null>
  slot<K extends SlotName>(name: K): SlotComponent<K>[]
  handleApi(request: Request): Promise<Response>

  readonly auth: AuthService
  /** Content types and their entries, for the admin's screens and the site's pages. */
  readonly content: ContentService
  /** The media library. */
  readonly media: MediaService
  /** Sending email, through the transport a plugin provides. */
  readonly mail: MailService
  /** The job queue: what a runner calls, and what Tools › Scheduled Actions lists. */
  readonly jobs: JobService
  /** Events and the webhooks they're sent to: Settings › Webhooks. */
  readonly webhooks: WebhookService
  /** `cms.cache` for the site's own code: its keys are apart from every plugin's. */
  readonly cache: Omit<CacheApi, 'store'>
  /** People's own accounts: signing up, resetting passwords, changing their details. */
  readonly accounts: AccountService
  /** Users and the fields plugins give them. */
  readonly users: UsersService
  /** The account page at a site path (`/account`, its reset and email pages), or `null`. */
  resolveAccount(
    pathname: string,
    searchParams: SearchParams,
    user: User | null,
  ): Promise<AccountResolution | null>
  /** The largest file one upload may be, in bytes. */
  readonly maxUploadBytes: number
  /** Answers a request for an upload, `/uploads/{key}`, from the storage. */
  serveUpload(request: Request, key: string): Promise<Response>
  can<C extends CapabilityName | MetaCapabilityName>(
    user: User | null,
    capability: C,
    ...args: CapabilityArgs<C>
  ): boolean
  roles(): RoleInfo[]
  capabilities(): CapabilityInfo[]
  plugins(): PluginStatus[]
  /** A settings page by qualified name, such as `core.general`, for this user. */
  settingsPage(key: string, user: User): SettingsResolution
  resolveAdminPage(
    pathname: string,
    searchParams: SearchParams,
    user: User,
  ): Promise<AdminResolution>
  adminMenu(user: User): AdminMenuSection[]
  /** The columns, meta boxes, row actions and bulk actions plugins add to a content type's screens. */
  contentScreens(type: string): ContentScreenExtensions
  /**
   * The content at a site path, after plugins' routes: a preview, the homepage, an archive, a
   * page, a post. `null` when there's none this user may see.
   */
  resolveContent(
    pathname: string,
    searchParams: SearchParams,
    user: User | null,
  ): Promise<ContentResolution | null>
  /** A plugin's template for a view of a type or taxonomy, if one replaces the default. */
  contentTemplate(view: ContentView, name: string): ContentTemplate['component'] | undefined
  adminUrl(name: string, params?: Record<string, string>): string
  actionUrl(pluginId: string, name: string): string
  readFlash(value: string | string[] | undefined): Flash | null
}

interface PageEntry {
  pluginId: string
  route: PageRoute<unknown>
}

/** State read once per `createKernel()`, shared by the recovery-mode reboots. */
interface Prepared {
  options: KernelOptions
  logger: Logger
  db: DatabaseContext
  generation: number
  /** Who is told of which event, read with the generation. */
  webhookTopics: WebhookTopics
  flash: FlashCodec
  configured: readonly string[]
  stored: ReadonlyMap<string, unknown>
  databaseUpdates: readonly string[]
  /** The admin entries by plugin id; empty where the admin isn't loaded. */
  adminEntries: ReadonlyMap<string, AdminDefinition>
}

/** Used by trial boots, which test values before they are stored. */
interface StartOptions {
  stored?: ReadonlyMap<string, unknown>
}

const ROUTE_NAME = /^[a-z][a-z0-9-]*$/
const RESERVED_PATHS = ['/api', '/_next', '/admin', UPLOADS_PATH]
/** Where uploads go without `uploads.dir` or a plugin's storage, relative to the site. */
const DEFAULT_UPLOADS_DIR = '.data/uploads'
/** The largest upload without `uploads.maxBytes`: 64 MB. */
const DEFAULT_MAX_UPLOAD = 64 * 1024 * 1024
const APP = 'app'
const PINNED = 'Plugins are switched on in the site configuration, so they cannot be changed here.'

/**
 * Boots the plugins. If one fails to migrate or set up, the kernel boots again without it (and
 * without anything that requires it), like WordPress recovery mode, unless `strict` is set.
 */
export async function createKernel(options: KernelOptions): Promise<Kernel> {
  return traced('kernel boot', { 'otw.kind': 'boot' }, () => startKernel(options, {}))
}

async function startKernel(options: KernelOptions, start: StartOptions): Promise<Kernel> {
  const logger = options.logger ?? consoleLogger
  const db = new DatabaseContext(options.db)
  const atDeploy = options.migrations === 'deploy'
  if (atDeploy) {
    const pending = await pendingMigrations(db, [coreDefinition])
    if (pending.length > 0) throw new DatabaseUpdateRequiredError(pending)
  } else {
    await runMigrations(db, [coreDefinition], logger)
  }
  // Read the generation before the state it guards, so a change in between triggers a reboot.
  const { generation, webhookTopics } = await readBootState(db.root)
  const prepared: Prepared = {
    options,
    logger,
    db,
    generation,
    webhookTopics,
    flash: createFlashCodec(options.secret ?? (await ensureSecret(db.root))),
    configured: options.active ?? (await loadActiveIds(db.root, options.plugins)),
    stored: start.stored ?? (await loadStoredSettings(db.root)),
    databaseUpdates: [],
    adminEntries: adminEntriesByPlugin(options),
  }
  const failed = new Map<string, string>()
  if (atDeploy) {
    // Off until their migrations run, as WooCommerce waits for "Update database".
    const configured = options.plugins.filter((plugin) => prepared.configured.includes(plugin.id))
    const pending = new Map<string, string[]>()
    for (const key of await pendingMigrations(db, configured)) {
      const id = key.slice(0, key.indexOf('/'))
      pending.set(id, [...(pending.get(id) ?? []), key])
    }
    for (const [id, keys] of pending) {
      failed.set(
        id,
        `Needs a database update (${keys.join(', ')}). Run \`cms migrate\`, or update it from the admin.`,
      )
      logger.warn(`Plugin "${id}" is waiting for a database update`, { plugin: id, pending: keys })
    }
    prepared.databaseUpdates = [...pending.keys()]
  }

  for (;;) {
    try {
      return await boot(
        prepared,
        prepared.configured.filter((id) => !failed.has(id)),
        failed,
      )
    } catch (error) {
      if (!(error instanceof PluginBootError) || options.strict) throw error
      logger.error(`Booting without plugin "${error.pluginId}"`, { plugin: error.pluginId, error })
      failed.set(error.pluginId, error.message)
    }
  }
}

/** The admin entries by plugin id, each for an installed plugin, one per plugin. */
function adminEntriesByPlugin({
  plugins,
  admin = [],
}: KernelOptions): ReadonlyMap<string, AdminDefinition> {
  const installed = new Set(plugins.map((plugin) => plugin.id))
  const entries = new Map<string, AdminDefinition>()
  for (const entry of admin) {
    const id = entry.plugin.id
    if (!installed.has(id)) throw new Error(`Admin entry for "${id}", which isn't installed`)
    if (entries.has(id)) throw new Error(`Plugin "${id}" has two admin entries`)
    entries.set(id, entry)
  }
  return entries
}

/** Admin slots: the core's (`admin.*`) and plugins' (`*.admin.*`), which only the admin shows. */
function isAdminSlot(name: string): boolean {
  return name.startsWith('admin.') || name.includes('.admin.')
}

async function boot(
  prepared: Prepared,
  activeIds: readonly string[],
  failed: ReadonlyMap<string, string>,
): Promise<Kernel> {
  const { options, logger, db } = prepared
  const coreVersion = options.coreVersion ?? CORE_VERSION
  const resolution = resolvePlugins(options.plugins, activeIds, coreVersion)
  const skipped = [...[...failed].map(([id, reason]) => ({ id, reason })), ...resolution.skipped]
  for (const { id, reason } of resolution.skipped) {
    logger.warn(`Plugin "${id}" not loaded: ${reason}`)
  }
  for (const warning of resolution.warnings) logger.warn(warning)

  if (options.migrations !== 'deploy') await runMigrations(db, resolution.order, logger)

  const settings = resolveSettings({
    declared: [coreDefinition, ...resolution.order].flatMap((plugin) =>
      declaredSettings(plugin.id, plugin.settings),
    ),
    env: options.env ?? {},
    stored: prepared.stored,
    overrides: options.settings ?? {},
  })
  for (const warning of settings.warnings) logger.warn(warning)
  const values = settings.values as SettingsValues
  const origins: OriginPolicy = {
    trustProxy: options.trustProxy ?? false,
    siteUrl: () => values['site.url'],
    allowedOrigins: options.allowedOrigins ?? [],
  }
  const settingsByKey = new Map(settings.settings.map((setting) => [setting.key, setting]))

  let sealed = false
  const assertOpen = (what: string) => {
    if (sealed) throw new Error(`Cannot register ${what} after boot; register it in setup()`)
  }
  const stores = {
    hooks: new HookBus({ logger, isolate: (fn) => db.isolate(fn), assertOpen }),
    registries: new RegistryStore(assertOpen),
    services: new ServiceStore(assertOpen),
    slots: new SlotStore(assertOpen),
    capabilities: new CapabilityStore(assertOpen, (capability, pluginId, error) =>
      logger.error('Capability check failed; denying', { capability, plugin: pluginId, error }),
    ),
    pages: new Router<PageEntry>(),
    apis: new Router<ApiEntry>(),
    adminPages: new Router<AdminPageEntry>(),
    menu: new AdminMenu(),
    settingsLayout: new SettingsLayoutStore(
      assertOpen,
      new Map(settings.settings.map((setting) => [setting.key, setting.pluginId])),
    ),
  }
  // Placed once every plugin has set up; actions read it only after boot.
  let settingsPages = new Map<string, ResolvedSettingsPage>()
  const installed = new Map(options.plugins.map((plugin) => [plugin.id, plugin]))
  const activeSet = new Set(resolution.order.map((plugin) => plugin.id))
  const overridesUsed = new Set<string>()
  // Who read each setting while setting up: only they can fail to start on a new value.
  const startupReaders = new Map<string, Set<string>>()
  let settingUp: string | undefined
  let tracingRequested = false
  const requiredCapabilities: { what: string; capability: string }[] = []
  const auth = createAuthService(db, {
    roleExists: (role) => stores.capabilities.hasRole(role),
    hashCost: options.passwordHashing,
  })
  const contentTypes = new ContentTypeStore(assertOpen, stores.capabilities)
  const taxonomies = new TaxonomyStore(assertOpen, stores.capabilities)
  const metaFields = new MetaStore(assertOpen)
  const templates = new TemplateStore(assertOpen)
  // Where entries live on the site, built once every plugin has registered its types.
  let contentRoutes: ContentRoutes | null = null
  const frontPage = () =>
    values['reading.show_on_front'] === 'page' ? (values['reading.page_on_front'] ?? null) : null
  const jobStore = new JobStore(assertOpen)
  const jobs = createJobService({
    db,
    logger,
    hooks: stores.hooks,
    store: jobStore,
    onQueued: options.onJobQueued,
  })
  const content = createContentService({
    db,
    types: contentTypes,
    hooks: stores.hooks,
    terms: createTermService({ db, taxonomies, hooks: stores.hooks }),
    meta: metaFields,
    links: { routes: () => contentRoutes, frontPage: () => frontPage() || null },
    jobs,
  })
  const contentScreens = new ContentScreenStore(assertOpen)
  const typesInMenu = new Map<string, number>()

  const userFields = new UserMetaStore(assertOpen)
  const imageSizes = new ImageSizeStore(assertOpen)
  const maxUploadBytes = options.uploads?.maxBytes ?? DEFAULT_MAX_UPLOAD
  if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes < 1) {
    throw new Error(`The upload limit must be a whole number of bytes, not ${maxUploadBytes}`)
  }
  const diskStorage = localStorage(options.uploads?.dir ?? resolvePath(DEFAULT_UPLOADS_DIR))
  let pluginStorage: { pluginId: string; storage: MediaStorage } | null = null
  const mediaStorage = () => pluginStorage?.storage ?? diskStorage
  const media = createMediaService({
    db,
    hooks: stores.hooks,
    logger,
    storage: mediaStorage,
    imageSizes: () => [
      ...coreImageSizes({
        thumbnail: [
          values['media.thumbnail_size_w'] ?? '',
          values['media.thumbnail_size_h'] ?? '',
          values['media.thumbnail_crop'] ?? true,
        ],
        medium: [values['media.medium_size_w'] ?? '', values['media.medium_size_h'] ?? ''],
        large: [values['media.large_size_w'] ?? '', values['media.large_size_h'] ?? ''],
      }),
      ...imageSizes.list(),
    ],
    byMonth: () => values['media.uploads_use_yearmonth_folders'] ?? true,
    maxBytes: maxUploadBytes,
  })
  let mailTransport: { pluginId: string; transport: MailTransport } | null = null
  const mail = createMailService({
    hooks: stores.hooks,
    logger,
    from: () => values['mail.from'] ?? '',
    transport: () => mailTransport?.transport ?? null,
    production: (options.env ?? process.env).NODE_ENV === 'production',
  })
  let cacheStore: { pluginId: string; store: CacheStore } | null = null
  const cache = createCacheService({
    db,
    memory: options.cacheMemory ?? createMemoryCache(),
    store: () => cacheStore?.store ?? null,
  })
  /** A plugin's cache store: one, as one object-cache drop-in replaces WordPress's. */
  const provideCacheStore = (pluginId: string, store: CacheStore) => {
    assertOpen(`cache store from "${pluginId}"`)
    if (cacheStore) {
      throw new Error(
        `Plugin "${pluginId}" provides a cache store, but "${cacheStore.pluginId}" already does; only one can`,
      )
    }
    const methods = ['get', 'set', 'delete', 'flush'] as const
    if (!store || methods.some((method) => typeof store[method] !== 'function')) {
      throw new TypeError(`The cache store from "${pluginId}" needs ${methods.join(', ')}`)
    }
    cacheStore = { pluginId, store }
  }
  /** A plugin's mail transport: one, as one SMTP plugin replaces wp_mail()'s mailer. */
  const provideTransport = (pluginId: string, transport: MailTransport) => {
    assertOpen(`mail transport from "${pluginId}"`)
    if (mailTransport) {
      throw new Error(
        `Plugin "${pluginId}" provides a mail transport, but "${mailTransport.pluginId}" already does; only one can`,
      )
    }
    if (!transport || typeof transport.send !== 'function') {
      throw new TypeError(`The mail transport from "${pluginId}" needs a send() method`)
    }
    mailTransport = { pluginId, transport }
  }
  /** A plugin's storage, checked as far as it can be before it's used. */
  const provideStorage = (pluginId: string, storage: MediaStorage) => {
    assertOpen(`media storage from "${pluginId}"`)
    if (pluginStorage) {
      throw new Error(
        `Plugin "${pluginId}" provides media storage, but "${pluginStorage.pluginId}" already does; only one can`,
      )
    }
    const methods = ['create', 'read', 'stat', 'delete', 'url'] as const
    if (!storage || methods.some((method) => typeof storage[method] !== 'function')) {
      throw new TypeError(`Media storage from "${pluginId}" needs ${methods.join(', ')}`)
    }
    pluginStorage = { pluginId, storage }
  }

  /** Registers the type, and its list, Add New and edit screens and menu items when it has them. */
  const registerContentType = (
    pluginId: string,
    name: string,
    definition: ContentTypeDefinition,
  ) => {
    if (taxonomies.has(`${pluginId}.${name}`)) {
      throw new Error(`Content type "${pluginId}.${name}" has a taxonomy's name; they share names`)
    }
    const type = contentTypes.register(pluginId, name, definition)
    const base = type.adminPath
    if (!base) return
    const screen = (kind: ContentScreen, path: string) =>
      stores.adminPages.add(`${type.name}.${kind}`, path, {
        pluginId,
        content: { type: type.name, screen: kind },
      })
    screen('list', base)
    screen('new', `${base}/new`)
    screen('edit', `${base}/:id`)
    if (type.revisions > 0) screen('revisions', `${base}/:id/revisions`)
    if (!type.showInMenu) return
    // Core's types have sections of their own (Posts, Pages); a plugin's come first in its section.
    const index = typesInMenu.get(pluginId) ?? 0
    typesInMenu.set(pluginId, index + 1)
    const parent = pluginId === CORE ? base.slice(ADMIN_PREFIX.length + 1) : undefined
    const order = pluginId === CORE ? 0 : -100 + 2 * index
    const item = { pluginId, parent, capability: type.capabilities.edit }
    stores.menu.add({
      ...item,
      key: `${type.name}.list`,
      label: `All ${type.labels.plural}`,
      url: base,
      order,
    })
    stores.menu.add({
      ...item,
      key: `${type.name}.new`,
      label: `Add New ${type.labels.singular}`,
      url: `${base}/new`,
      order: order + 1,
    })
  }

  const registerPage = (pluginId: string, route: PageRoute<unknown>) => {
    assertOpen(`page route "${route.name}"`)
    if (!ROUTE_NAME.test(route.name)) throw new Error(`Invalid page route name "${route.name}"`)
    if (typeof route.component !== 'function') {
      throw new TypeError(`Page "${route.name}" needs a component`)
    }
    const key = `${pluginId}.${route.name}`
    const override = options.routes?.[key]
    if (override !== undefined) {
      const expected = paramNames(parsePattern(route.path)).sort().join(',')
      const actual = paramNames(parsePattern(override)).sort().join(',')
      if (expected !== actual) {
        throw new Error(`Override for "${key}" must use parameters [${expected}], got [${actual}]`)
      }
      overridesUsed.add(key)
    }
    const path = override ?? route.path
    if (RESERVED_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
      throw new Error(`Page "${key}" cannot use reserved path "${path}"`)
    }
    stores.pages.add(key, path, { pluginId, route })
  }

  const registerApi = (pluginId: string, route: ApiRoute) => {
    assertOpen(`API route ${route.method} ${route.path}`)
    if (!HTTP_METHODS.includes(route.method)) {
      throw new Error(`Unsupported method "${route.method}"`)
    }
    if (typeof route.handler !== 'function') {
      throw new TypeError(`API route ${route.path} needs a handler`)
    }
    stores.apis.add(
      `${pluginId} ${route.method} ${route.path}`,
      apiPath(pluginId, route.path),
      { pluginId, method: route.method, handler: route.handler },
      route.method,
    )
  }

  const registerAdminPage = (pluginId: string, page: AdminPage<unknown>) => {
    assertOpen(`admin page "${page.name}"`)
    if (!ROUTE_NAME.test(page.name)) throw new Error(`Invalid admin page name "${page.name}"`)
    if (typeof page.component !== 'function') {
      throw new TypeError(`Admin page "${page.name}" needs a component`)
    }
    const key = `${pluginId}.${page.name}`
    const path = adminPath(pluginId, page.path)
    if (page.menu && paramNames(parsePattern(path)).length > 0) {
      throw new Error(`Admin page "${key}" has parameters, so it cannot be in the menu`)
    }
    stores.adminPages.add(key, path, { pluginId, page })
    requiredCapabilities.push({ what: `Admin page "${key}"`, capability: page.capability })
    if (page.menu) {
      stores.menu.add({ ...page.menu, key, pluginId, url: path, capability: page.capability })
    }
  }

  const registerSettingsPage = (pluginId: string, page: SettingsPage) => {
    const path = adminPath(pluginId, page.path)
    if (paramNames(parsePattern(path)).length > 0) {
      throw new Error(`Settings page "${pluginId}.${page.name}" cannot have parameters`)
    }
    const entry = stores.settingsLayout.page(pluginId, page, path)
    stores.adminPages.add(entry.key, path, { pluginId, settingsPage: entry.key })
    requiredCapabilities.push({
      what: `Settings page "${entry.key}"`,
      capability: entry.capability,
    })
  }

  const registerAction = (pluginId: string, action: InternalAction) => {
    assertOpen(`admin action "${action.name}"`)
    if (!ROUTE_NAME.test(action.name)) throw new Error(`Invalid admin action name "${action.name}"`)
    if (typeof action.handler !== 'function') {
      throw new TypeError(`Admin action "${action.name}" needs a handler`)
    }
    const path = `/actions/${action.name}`
    stores.apis.add(
      `${pluginId} POST ${path}`,
      apiPath(pluginId, path),
      {
        pluginId,
        method: 'POST',
        handler: createActionHandler(action, {
          pluginId,
          userForSession: (token) => auth.userForSession(token),
          can: (user, capability) => stores.capabilities.can(user, capability),
          flash: prepared.flash,
          logger: withContext(logger, { plugin: pluginId }),
          origins,
        }),
      },
      'POST',
    )
  }

  // A trial boot's warnings repeat the running kernel's; its errors are the point of the trial.
  const trialOptions: KernelOptions = {
    ...options,
    strict: false,
    onChange: undefined,
    onJobQueued: undefined,
    // Only the kernel that serves requests decides whether they're recorded.
    traces: undefined,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (message, context) => logger.error(message, context),
    },
  }

  const changed = async () => {
    await bumpGeneration(db.root)
    options.onChange?.()
  }

  registerCoreCapabilities(stores.capabilities)
  /** Registers the taxonomy, and its screen and menu item under its first type with screens. */
  const registerTaxonomy = (pluginId: string, name: string, definition: TaxonomyDefinition) => {
    if (contentTypes.get(`${pluginId}.${name}`)) {
      throw new Error(`Taxonomy "${pluginId}.${name}" has a content type's name; they share names`)
    }
    const taxonomy = taxonomies.register(
      pluginId,
      name,
      definition,
      (type) => contentTypes.get(type)?.adminPath,
    )
    const base = taxonomy.adminPath
    if (!base) return
    const screen = (kind: 'terms' | 'term', path: string) =>
      stores.adminPages.add(`${taxonomy.name}.${kind}`, path, {
        pluginId,
        taxonomy: { name: taxonomy.name, screen: kind },
      })
    screen('terms', base)
    screen('term', `${base}/:id`)
    const type = taxonomy.types.map((name) => contentTypes.get(name)).find((t) => t?.adminPath)!
    if (!type.showInMenu) return
    const index = typesInMenu.get(`${type.pluginId}:taxonomies`) ?? 0
    typesInMenu.set(`${type.pluginId}:taxonomies`, index + 1)
    stores.menu.add({
      key: `${taxonomy.name}.terms`,
      pluginId,
      label: taxonomy.labels.plural,
      url: base,
      // After the type's All and Add New, in the type's section: Posts › Categories.
      order: type.pluginId === CORE ? 2 + index : -50 + index,
      capability: taxonomy.capabilities.manage,
      parent:
        type.pluginId === CORE ? type.adminPath!.slice(ADMIN_PREFIX.length + 1) : type.pluginId,
    })
  }

  registerCoreContent({ register: registerContentType, taxonomy: registerTaxonomy })
  const eventStore = new EventStore(assertOpen)
  const webhooks = createWebhookService({
    db,
    logger,
    store: eventStore,
    jobs,
    fetch: options.fetch,
    userAgent: `cms-webhooks/${coreVersion}`,
    subscriptions: prepared.webhookTopics,
    changed: () => changed(),
  })
  registerCoreEvents({
    store: eventStore,
    hooks: stores.hooks,
    webhooks,
    permalinks: (list) => content.permalinks(list),
  })
  registerCoreJobs({ store: jobStore, db, logger, content, jobs, webhooks, cache })
  const actions = coreActions({
    auth,
    jobs,
    webhooks,
    canUseAdmin: (user) => stores.capabilities.can(user, 'core.access_admin'),
    async activate(id) {
      if (options.active) throw new ActionError(PINNED)
      const plugin = installed.get(id)
      if (!plugin) throw new ActionError('That plugin is not installed.')
      const name = displayName(plugin, id)
      const current = await loadActiveIds(db.root, options.plugins)
      if (current.includes(id)) return `${name} is already active.`
      const blockers = activationBlockers(plugin, installed, new Set(current), coreVersion)
      if (blockers.length > 0) throw new ActionError(blockers.join(' '))

      // Switching a plugin on is the moment to update its tables, even when the site migrates at
      // deploy: an administrator asked for it, and it runs under the same lock.
      if (options.migrations === 'deploy') await runMigrations(db, [plugin], logger)
      // Boot once with it switched on, as WordPress does, so a fatal error never reaches visitors.
      const trial = await createKernel({ ...trialOptions, active: [...current, id] })
      if (!trial.isActive(id)) {
        const reason = trial.skipped.find((entry) => entry.id === id)?.reason ?? 'it did not load'
        throw new ActionError(`${name} could not be activated. ${reason}`)
      }
      await saveActive(db.root, id, true)
      await changed()
      return `${name} activated.`
    },
    async deactivate(id) {
      if (options.active) throw new ActionError(PINNED)
      const name = displayName(installed.get(id), id)
      const current = new Set(await loadActiveIds(db.root, options.plugins))
      if (!current.has(id)) return `${name} is already inactive.`
      const blockers = deactivationBlockers(id, options.plugins, current)
      if (blockers.length > 0) throw new ActionError(blockers.join(' '))
      await saveActive(db.root, id, false)
      await changed()
      return `${name} deactivated.`
    },
    updates: options.updates ?? null,
    async updateDatabase() {
      const result = await migrateSite({
        db: db.root,
        plugins: options.plugins,
        active: options.active,
        logger,
        coreVersion,
      })
      if ('applied' in result && result.applied.length > 0) await changed()
      return 'Database updated.'
    },
    async saveSettings(key, user, form) {
      const page = settingsPages.get(key)
      if (!page) throw new ActionError('That settings page does not exist.')
      if (!stores.capabilities.can(user, page.capability)) throw new ForbiddenError()
      const updates = pageUpdates(page, settingsByKey, form)
      await trialSettings(updates)
      await saveSettings(db.root, updates)
      await changed()
    },
  })
  for (const action of actions) registerAction(CORE, action)
  // Where nothing runs between requests, a cron request runs the jobs that are due.
  registerApi(CORE, {
    method: 'GET',
    path: '/cron',
    handler: cronHandler({
      secret: () => (options.env ?? {}).CRON_SECRET,
      runDue: (runOptions) => jobs.runDue(runOptions),
    }),
  })
  const contentForms = contentActions({
    content,
    types: contentTypes,
    screens: contentScreens,
    can: (user, capability, ...args) => stores.capabilities.can(user, capability, ...args),
    transaction: (fn) => db.transaction(() => fn()),
    locale: () => values['site.locale'],
  })
  for (const action of contentForms) registerAction(CORE, action)
  // WordPress's upload.php, media-new.php and the attachment's edit screen.
  stores.adminPages.add('core.media.library', MEDIA_PATH, { pluginId: CORE, media: 'library' })
  stores.adminPages.add('core.media.new', `${MEDIA_PATH}/new`, { pluginId: CORE, media: 'new' })
  stores.adminPages.add('core.media.edit', `${MEDIA_PATH}/:id`, { pluginId: CORE, media: 'edit' })
  const mediaDependencies = {
    media,
    can: (user: User, capability: string, ...args: unknown[]) =>
      stores.capabilities.can(user, capability, ...args),
    transaction: <T>(fn: () => Promise<T>) => db.transaction(() => fn()),
    maxBytes: maxUploadBytes,
  }
  for (const action of mediaActions(mediaDependencies)) registerAction(CORE, action)
  const accounts = createAccountService({
    db,
    auth,
    mail,
    logger,
    siteTitle: () => values['site.title'] ?? '',
    registrationOpen: () => values['users.can_register'] ?? false,
    roleExists: (role) => stores.capabilities.hasRole(role),
    hashCost: options.passwordHashing,
  })
  const users = createUsersService({ db, fields: userFields, accounts })
  for (const action of accountActions({ auth, accounts, users })) registerAction(CORE, action)
  const userForms = userActions({
    auth,
    accounts,
    users,
    can: (user, capability) => stores.capabilities.can(user, capability),
  })
  for (const action of userForms) registerAction(CORE, action)
  // user-edit.php; the router sends someone editing themselves to their Profile.
  stores.adminPages.add('core.user-edit', '/admin/users/:id', { pluginId: CORE, user: 'edit' })
  const resolveAccount = createAccountPages({
    accounts,
    users,
    canUseAdmin: (user) => stores.capabilities.can(user, 'core.access_admin'),
    actionUrl: (name) => actionPath(CORE, name),
    readFlash: (value) => prepared.flash.decode(value),
  })
  registerApi(CORE, mediaUploadRoute(mediaDependencies))
  registerApi(CORE, mediaListRoute(mediaDependencies))

  /** These plugins and, transitively, the active plugins they require or optionally use. */
  const withDependencies = (ids: Iterable<string>): string[] => {
    const needed = new Set<string>()
    const visit = (id: string) => {
      if (needed.has(id) || !activeSet.has(id)) return
      needed.add(id)
      const { requires, optional } = installed.get(id)!
      for (const dependency of Object.keys({ ...requires, ...optional })) visit(dependency)
    }
    for (const id of ids) visit(id)
    return resolution.order.map((plugin) => plugin.id).filter((id) => needed.has(id))
  }

  /**
   * Boots the plugins that read a changed setting while starting, with the new values, so a value
   * a plugin rejects at startup never reaches visitors. Field validation can't catch these: they
   * depend on other values or on what the plugin does with them. Plugins that didn't read the
   * setting can't fail on it, so they stay out and a save costs what it touches, not every plugin.
   */
  const trialSettings = async (updates: ReadonlyMap<string, SettingValue | undefined>) => {
    const read = [...updates.keys()].filter((key) => {
      const setting = settingsByKey.get(key)!
      const fallback = setting.definition.type === 'secret' ? undefined : setting.definition.default
      return startupReaders.has(key) && (updates.get(key) ?? fallback) !== setting.value
    })
    if (read.length === 0) return
    const readers = read.flatMap((key) => [...startupReaders.get(key)!])
    // The owners declare the settings, so their values resolve in the trial.
    const owners = read.map((key) => settingsByKey.get(key)!.pluginId)
    const stored = new Map(await loadStoredSettings(db.root))
    for (const [key, value] of updates) {
      if (value === undefined) stored.delete(key)
      else stored.set(key, value)
    }
    const trial = await startKernel(
      { ...trialOptions, active: withDependencies([...readers, ...owners]) },
      { stored },
    )
    const broken = trial.skipped.filter((plugin) => activeSet.has(plugin.id))
    if (broken.length > 0) {
      const names = broken.map((plugin) => displayName(installed.get(plugin.id), plugin.id))
      throw new ActionError(
        `Settings not saved: ${names.join(', ')} could not start with them. ${broken[0]!.reason}`,
      )
    }
  }
  registerCoreSettings(stores.settingsLayout)

  const hooksFor = (pluginId: string): HooksApi => ({
    addFilter: (name, handler, opts) =>
      stores.hooks.addFilter(pluginId, name, handler, opts?.priority),
    applyFilters: (name, value, context) => stores.hooks.applyFilters(name, value, context),
    addAction: (name, handler, opts) =>
      stores.hooks.addAction(pluginId, name, handler, opts?.priority),
    doAction: (name, payload) => stores.hooks.doAction(name, payload),
  })

  // The main entry (setup) runs everywhere, the site included; the admin entry only in the admin.
  const contextFor = (plugin: PluginDefinition, entry: 'setup' | 'admin'): PluginContext => {
    const inAdminEntry = (what: string) => {
      if (entry === 'admin') return
      throw new Error(
        `Register ${what} in the plugin's admin entry (defineAdmin), not in setup(): setup() also runs for the site, so its code would reach visitors`,
      )
    }
    const inSetup = (what: string) => {
      if (entry === 'setup') return
      throw new Error(
        `Change roles and capabilities (${what}) in setup(), so every part of the site agrees on them: the admin entry is loaded only where the admin is`,
      )
    }
    const declared = new Set([
      ...Object.keys(plugin.requires ?? {}),
      ...Object.keys(plugin.optional ?? {}),
    ])
    const available = resolution.available.get(plugin.id) ?? new Set<string>()
    return {
      plugin: { id: plugin.id, version: plugin.version },
      hooks: hooksFor(plugin.id),
      registries: {
        define: (name) => {
          stores.registries.define(plugin.id, name)
          return stores.registries.view(plugin.id, name)
        },
        get: (name) => stores.registries.view(plugin.id, name),
      },
      services: {
        provide: (name, service) => stores.services.provide(plugin.id, name, service),
        get: (name) => stores.services.get(name) as never,
      },
      routes: {
        page: (route) => registerPage(plugin.id, route as PageRoute<unknown>),
        api: (route) => registerApi(plugin.id, route),
        url: (name, params) => stores.pages.url(name, params),
        apiUrl: (path) => apiPath(plugin.id, path),
        signInUrl: (returnTo) => signInUrl(returnTo),
      },
      slots: {
        fill: (name, fill) => {
          if (isAdminSlot(name) && entry === 'setup') {
            throw new Error(
              `Fill the admin slot "${name}" in the plugin's admin entry (defineAdmin), not in setup(): setup() also runs for the site, so its code would reach visitors`,
            )
          }
          if (!isAdminSlot(name) && entry === 'admin') {
            throw new Error(
              `Fill the site slot "${name}" in setup(): the admin entry isn't loaded where visitors are, so the fill would never show there`,
            )
          }
          stores.slots.fill(plugin.id, name, fill.component as SlotComponent, fill.priority)
        },
        get: (name) => stores.slots.get(name).map((fill) => fill.component) as never,
      },
      settings: {
        get: (key) => {
          if (settingUp !== undefined) {
            const readers = startupReaders.get(key) ?? new Set()
            startupReaders.set(key, readers.add(settingUp))
          }
          return values[key]
        },
      },
      auth: {
        role: (id, definition) => {
          inSetup(`role "${id}"`)
          stores.capabilities.role(plugin.id, id, definition)
        },
        capability: (name, definition) => {
          inSetup(`capability "${name}"`)
          stores.capabilities.capability(plugin.id, name, definition)
        },
        grant: (role, capabilities) => {
          inSetup(`granting "${role}"`)
          stores.capabilities.grant(plugin.id, role, capabilities)
        },
        revoke: (role, capabilities) => {
          inSetup(`revoking from "${role}"`)
          stores.capabilities.revoke(plugin.id, role, capabilities)
        },
        metaCapability: (name, definition) => {
          inSetup(`meta capability "${name}"`)
          stores.capabilities.metaCapability(plugin.id, name, definition as never)
        },
        extendCapability: (name, extension) => {
          inSetup(`extending "${name}"`)
          stores.capabilities.extendCapability(plugin.id, name, extension as never)
        },
        can: (user, capability, ...args) => stores.capabilities.can(user, capability, ...args),
      },
      content: {
        ...content,
        type: (name, definition) => {
          if (entry === 'admin') {
            throw new Error(
              `Register content type "${plugin.id}.${name}" in setup(), so every part of the site knows it: the admin entry is loaded only where the admin is`,
            )
          }
          registerContentType(plugin.id, name, definition)
        },
        taxonomy: (name, definition) => {
          if (entry === 'admin') {
            throw new Error(
              `Register taxonomy "${plugin.id}.${name}" in setup(), so every part of the site knows it: the admin entry is loaded only where the admin is`,
            )
          }
          registerTaxonomy(plugin.id, name, definition)
        },
        template: (template) => {
          if (entry === 'admin') {
            throw new Error(
              `Register templates in setup(): they render the site's pages, where the admin entry isn't loaded`,
            )
          }
          templates.register(plugin.id, template)
        },
        meta: (key, definition) => {
          if (entry === 'admin') {
            throw new Error(
              `Register custom field "${key}" in setup(), so every part of the site knows it: the admin entry is loaded only where the admin is`,
            )
          }
          metaFields.register(plugin.id, key, definition)
        },
      },
      media: {
        ...media,
        imageSize: (name, size) => {
          if (entry === 'admin') {
            throw new Error(
              `Register image size "${plugin.id}.${name}" in setup(): uploads use it wherever they're made`,
            )
          }
          imageSizes.register(plugin.id, name, size)
        },
        storage: (storage) => {
          if (entry === 'admin') {
            throw new Error(
              `Provide media storage in setup(): the site serves uploads, where the admin entry isn't loaded`,
            )
          }
          provideStorage(plugin.id, storage)
        },
      },
      users: {
        ...users,
        meta: (key, definition) => {
          if (entry === 'admin') {
            throw new Error(
              `Register user field "${key}" in setup(), so every part of the site knows it: the admin entry is loaded only where the admin is`,
            )
          }
          userFields.register(plugin.id, key, definition as never)
        },
      },
      mail: {
        ...mail,
        transport: (transport) => {
          if (entry === 'admin') {
            throw new Error(
              `Provide the mail transport in setup(): the site sends email too, where the admin entry isn't loaded`,
            )
          }
          provideTransport(plugin.id, transport)
        },
      },
      jobs: {
        define: (name, definition) => {
          if (entry === 'admin') {
            throw new Error(
              `Define the job "${name}" in setup(): jobs run wherever the site does, where the admin entry isn't loaded`,
            )
          }
          jobStore.define(plugin.id, name, definition as never)
        },
        enqueue: (name, args, enqueueOptions) =>
          jobs.enqueue(name, args as Record<string, unknown>, enqueueOptions),
        cancel: (name, unique) => jobs.cancel(name, unique),
        next: (name, unique) => jobs.next(name, unique),
      },
      events: {
        define: (name, definition) => {
          if (entry === 'admin') {
            throw new Error(
              `Define the event "${name}" in setup(): events are emitted wherever the site runs, where the admin entry isn't loaded`,
            )
          }
          eventStore.define(plugin.id, name, definition)
        },
        emit: (name, data) => webhooks.emit(name, data),
        hasSubscribers: (name) => webhooks.hasSubscribers(name),
      },
      cache: {
        ...cache.for(plugin.id),
        store: (store) => {
          if (entry === 'admin') {
            throw new Error(
              `Provide the cache store in setup(): the site caches too, where the admin entry isn't loaded`,
            )
          }
          provideCacheStore(plugin.id, store)
        },
      },
      admin: {
        page: (page) => {
          inAdminEntry(`admin page "${plugin.id}.${page.name}"`)
          registerAdminPage(plugin.id, page as AdminPage<unknown>)
        },
        settingsPage: (page) => {
          inAdminEntry(`settings page "${plugin.id}.${page.name}"`)
          registerSettingsPage(plugin.id, page)
        },
        settingsSection: (section) => {
          inAdminEntry(`settings section "${plugin.id}.${section.name}"`)
          stores.settingsLayout.section(plugin.id, section)
        },
        settingsFields: (fields) => {
          inAdminEntry(`settings fields for "${fields.section}"`)
          stores.settingsLayout.fields(plugin.id, fields)
        },
        action: (action) => {
          inAdminEntry(`admin action "${plugin.id}.${action.name}"`)
          requiredCapabilities.push({
            what: `Admin action "${plugin.id}.${action.name}"`,
            capability: action.capability,
          })
          registerAction(plugin.id, {
            name: action.name,
            capability: action.capability,
            // A capability is always set, so the wrapper has already required a signed-in user.
            handler: ({ user, form }) => action.handler({ user: user!, form }),
          })
        },
        url: (name, params = {}) => {
          if (name.startsWith('/')) {
            return fillPattern(
              parsePattern(adminPath(plugin.id, name)),
              params,
              `Admin path "${name}"`,
            )
          }
          if (!options.admin && !stores.adminPages.get(name)) {
            throw new Error(
              `Admin page names are known only where the admin is loaded ("${name}"). Here, link to the page by its path: cms.admin.url('/path/of/the/page')`,
            )
          }
          return stores.adminPages.url(name, params)
        },
        actionUrl: (name) => actionPath(plugin.id, name),
        column: (types, column) => {
          inAdminEntry(`column "${plugin.id}.${column.name}"`)
          contentScreens.column(plugin.id, types, column as never)
        },
        metaBox: (types, box) => {
          inAdminEntry(`meta box "${plugin.id}.${box.name}"`)
          contentScreens.metaBox(plugin.id, types, box)
        },
        rowAction: (types, action) => {
          inAdminEntry(`row action "${plugin.id}.${action.name}"`)
          contentScreens.rowAction(plugin.id, types, action)
        },
        bulkAction: (types, action) => {
          inAdminEntry(`bulk action "${plugin.id}.${action.name}"`)
          requiredCapabilities.push({
            what: `Bulk action "${plugin.id}.${action.name}"`,
            capability: action.capability,
          })
          contentScreens.bulkAction(plugin.id, types, action)
        },
      },
      traces: {
        enable: () => {
          tracingRequested = true
        },
        get available() {
          return Boolean(options.traces?.enabled)
        },
        currentId: currentTraceId,
        keep: (id) => options.traces?.keep(id),
        get: (id) => options.traces?.get(id),
        list: () => options.traces?.list() ?? [],
      },
      logger: withContext(logger, { plugin: plugin.id }),
      get db() {
        return db.current
      },
      transaction: (fn) => db.transaction(fn),
      when: async (pluginId, fn) => {
        if (!declared.has(pluginId)) {
          throw new Error(
            `Plugin "${plugin.id}" called when("${pluginId}") without declaring it in requires or optional`,
          )
        }
        if (available.has(pluginId)) await fn()
      },
      isActive: (pluginId) => activeSet.has(pluginId),
    }
  }

  for (const plugin of resolution.order) {
    // Setups run one at a time, so a read through another plugin's service counts as this one's.
    settingUp = plugin.id
    try {
      await traced(`setup ${plugin.id}`, { 'otw.kind': 'setup', 'otw.plugin': plugin.id }, () =>
        plugin.setup?.(contextFor(plugin, 'setup')),
      )
    } catch (error) {
      throw new PluginBootError(plugin.id, 'setup', error)
    }
  }
  // After every setup(), so an admin entry can use any plugin's services and slots.
  for (const plugin of resolution.order) {
    const admin = prepared.adminEntries.get(plugin.id)
    if (!admin) continue
    settingUp = plugin.id
    try {
      await traced(
        `admin setup ${plugin.id}`,
        { 'otw.kind': 'setup', 'otw.plugin': plugin.id },
        () => admin.setup(contextFor(plugin, 'admin')),
      )
    } catch (error) {
      throw new PluginBootError(plugin.id, 'admin setup', error)
    }
  }
  settingUp = undefined
  await options.traces?.setEnabled(tracingRequested)
  sealed = true
  stores.capabilities.seal()
  const label = (pluginId: string) => displayName(installed.get(pluginId), pluginId)
  const layout = stores.settingsLayout.resolve({
    isActive: (pluginId) => activeSet.has(pluginId),
    label,
    automaticUrl: (pluginId) => adminPath(pluginId, '/settings'),
  })
  for (const page of layout.pages) {
    if (page.automatic) {
      try {
        stores.adminPages.add(page.key, page.url, {
          pluginId: page.pluginId,
          settingsPage: page.key,
        })
      } catch (error) {
        throw new PluginBootError(page.pluginId, 'setup', error)
      }
    }
    stores.menu.add({
      ...page.menu,
      key: page.key,
      pluginId: page.pluginId,
      url: page.url,
      capability: page.capability,
    })
  }
  settingsPages = new Map(layout.pages.map((page) => [page.key, page]))
  const menuWarnings = stores.menu.seal({
    active: resolution.order.map((plugin) => plugin.id),
    installed: new Set(installed.keys()),
    label,
    icon: (pluginId) => installed.get(pluginId)?.icon ?? 'admin',
  })

  contentRoutes = new ContentRoutes({
    types: contentTypes.list(),
    taxonomies: taxonomies.list(),
    overrides: options.routes ?? {},
    used: (key) => overridesUsed.add(key),
  })
  const resolveContent = createSiteContent({
    db,
    content,
    routes: () => contentRoutes,
    can: (user, capability, ...args) => stores.capabilities.can(user, capability, ...args),
    setting: (key) => {
      const value = (values as Record<string, unknown>)[key]
      return typeof value === 'string' ? value : undefined
    },
    getUsers: (ids) => auth.getUsers(ids),
    media: (ids) => media.getMany(ids),
  })

  const registrationWarnings = [
    ...unusedOverrideWarnings(options.routes, overridesUsed),
    ...contentScreens
      .allMetaBoxes()
      .flatMap((box) =>
        (box.fields ?? [])
          .filter((key) => !metaFields.get(key))
          .map(
            (key) =>
              `Meta box "${box.key}" shows custom field "${key}", which no active plugin registers`,
          ),
      ),
    ...layout.warnings,
    ...menuWarnings,
    ...requiredCapabilities
      .filter(({ capability }) => !stores.capabilities.isDefined(capability))
      .map(
        ({ what, capability }) =>
          `${what} requires undeclared capability "${capability}"; only administrators can use it`,
      ),
  ]
  for (const warning of registrationWarnings) logger.warn(warning)
  const warnings = [...resolution.warnings, ...settings.warnings, ...registrationWarnings]

  return buildKernel({
    coreVersion,
    origins,
    prepared,
    resolution,
    skipped,
    warnings,
    stores,
    values,
    settingsByKey,
    settingsPages,
    installed,
    auth,
    content,
    contentTypes,
    contentScreens,
    templates,
    resolveContent,
    media,
    mediaStorage,
    maxUploadBytes,
    mail,
    jobs,
    webhooks,
    cache: cache.for(APP),
    accounts,
    resolveAccount,
    users,
  })
}

/** `?a=1&b=2` from a page's search parameters, or nothing: the page's own address, to come back to. */
function queryString(searchParams: SearchParams): string {
  const query = new URLSearchParams()
  for (const [name, value] of Object.entries(searchParams)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      query.append(name, item)
    }
  }
  const text = query.toString()
  return text ? `?${text}` : ''
}

function unusedOverrideWarnings(
  routes: KernelOptions['routes'],
  used: ReadonlySet<string>,
): string[] {
  return Object.keys(routes ?? {})
    .filter((key) => !used.has(key))
    .map((key) => `Route override "${key}" does not match any registered page route`)
}

function buildKernel(input: {
  coreVersion: string
  prepared: Prepared
  resolution: Resolution
  skipped: SkippedPlugin[]
  warnings: string[]
  stores: {
    hooks: HookBus
    registries: RegistryStore
    services: ServiceStore
    slots: SlotStore
    capabilities: CapabilityStore
    pages: Router<PageEntry>
    apis: Router<ApiEntry>
    adminPages: Router<AdminPageEntry>
    menu: AdminMenu
  }
  values: SettingsValues
  settingsByKey: ReadonlyMap<string, ResolvedSetting>
  settingsPages: ReadonlyMap<string, ResolvedSettingsPage>
  installed: ReadonlyMap<string, PluginDefinition>
  auth: AuthService
  content: ContentService
  contentTypes: ContentTypeStore
  contentScreens: ContentScreenStore
  templates: TemplateStore
  resolveContent: ReturnType<typeof createSiteContent>
  origins: OriginPolicy
  media: MediaService
  mediaStorage: () => MediaStorage
  maxUploadBytes: number
  mail: MailService
  jobs: JobService
  webhooks: WebhookService
  cache: Omit<CacheApi, 'store'>
  accounts: AccountService
  resolveAccount: ReturnType<typeof createAccountPages>
  users: UsersService
}): Kernel {
  const { prepared, stores, values, installed, origins } = input
  const { options, logger, db } = prepared
  const active = input.resolution.order.map((plugin) => plugin.id)
  const activeSet = new Set(active)
  const configured = new Set(prepared.configured)
  const capabilities = stores.capabilities

  const settingsPage = (key: string, user: User): SettingsResolution => {
    const page = input.settingsPages.get(key)
    if (!page) return { kind: 'not-found' }
    if (!capabilities.can(user, 'core.access_admin') || !capabilities.can(user, page.capability)) {
      return { kind: 'forbidden' }
    }
    return { kind: 'settings', key, title: page.title, view: pageView(page, input.settingsByKey) }
  }

  /**
   * A content type's screens need the type's `edit` capability, as edit.php and post-new.php need
   * `edit_posts`; an entry's edit screen needs the meta capability on that entry too.
   */
  /** A taxonomy's screen needs `manage_`, as edit-tags.php does; a term's, `edit_` on it too. */
  const taxonomyScreen = async (
    screen: { name: string; screen: 'terms' | 'term' },
    params: Record<string, string>,
    user: User,
  ): Promise<AdminResolution> => {
    const taxonomy = input.content.getTaxonomy(screen.name)!
    if (
      !capabilities.can(user, 'core.access_admin') ||
      !capabilities.can(user, taxonomy.capabilities.manage)
    ) {
      return { kind: 'forbidden' }
    }
    if (screen.screen === 'terms') return { kind: 'taxonomy-terms', taxonomy }
    const term = await input.content.getTerm(params.id ?? '')
    if (term?.taxonomy !== taxonomy.name) return { kind: 'not-found' }
    if (!capabilities.can(user, taxonomy.capabilities.editTerm, term)) return { kind: 'forbidden' }
    return { kind: 'taxonomy-term', taxonomy, term }
  }

  /** The library and Add New need `core.upload_files`, as upload.php does; a file's screen, `core.edit_media` on it. */
  const mediaScreen = async (
    screen: MediaScreen,
    params: Record<string, string>,
    user: User,
  ): Promise<AdminResolution> => {
    if (
      !capabilities.can(user, 'core.access_admin') ||
      !capabilities.can(user, 'core.upload_files')
    ) {
      return { kind: 'forbidden' }
    }
    if (screen === 'library') return { kind: 'media-library' }
    if (screen === 'new') return { kind: 'media-new' }
    const item = await input.media.get(params.id ?? '')
    if (!item) return { kind: 'not-found' }
    if (!capabilities.can(user, 'core.edit_media', item)) return { kind: 'forbidden' }
    return { kind: 'media-edit', item }
  }

  const contentScreen = async (
    screen: { type: string; screen: ContentScreen },
    params: Record<string, string>,
    user: User,
  ): Promise<AdminResolution> => {
    const type = input.contentTypes.get(screen.type)!
    if (
      !capabilities.can(user, 'core.access_admin') ||
      !capabilities.can(user, type.capabilities.edit)
    ) {
      return { kind: 'forbidden' }
    }
    if (screen.screen === 'list') return { kind: 'content-list', type }
    if (screen.screen === 'new') return { kind: 'content-edit', type, entry: null }
    const entry = await input.content.get(params.id ?? '')
    if (entry?.type !== type.name) return { kind: 'not-found' }
    if (!capabilities.can(user, type.capabilities.editEntry, entry)) return { kind: 'forbidden' }
    if (screen.screen === 'revisions') return { kind: 'content-revisions', type, entry }
    return { kind: 'content-edit', type, entry }
  }

  return {
    coreVersion: input.coreVersion,
    brand: options.brand ?? DEFAULT_BRAND,
    active,
    skipped: input.skipped,
    databaseUpdates: prepared.databaseUpdates,
    updates: options.updates ?? null,
    warnings: input.warnings,
    generation: prepared.generation,
    activation: options.active ? 'pinned' : 'database',
    get db() {
      return db.current
    },
    isCurrent: async () => (await readGeneration(db.root)) === prepared.generation,
    isActive: (pluginId) => activeSet.has(pluginId),
    transaction: (fn) => db.transaction(fn),
    applyFilters: (name, value, context) => stores.hooks.applyFilters(name, value, context),
    doAction: (name, payload) => stores.hooks.doAction(name, payload),
    service: (name) => stores.services.get(name) as never,
    registry: (name) => stores.registries.view(APP, name),
    setting: (key) => values[key],
    url: (name, params) => stores.pages.url(name, params),
    async resolvePage(pathname, searchParams = {}, options = {}) {
      const match = stores.pages.match(pathname)
      if (!match) return null
      const { pluginId, route } = match.route.value
      // Looked up on the first call only: most pages never ask, and a session costs a query.
      let lookup: Promise<User | null> | undefined
      const user = () => (lookup ??= options.user?.() ?? Promise.resolve(null))
      const here = `${pathname}${queryString(searchParams)}`
      const context: PageContext = {
        params: match.params,
        searchParams,
        user,
        async requireUser() {
          const signedIn = await user()
          if (!signedIn) throw new PageRedirect(signInUrl(here))
          return signedIn
        },
      }
      const key = match.route.key
      const span = { 'otw.kind': 'page', 'otw.plugin': pluginId, 'otw.route': key }
      const data = route.load
        ? await traced(`load ${key}`, span, () => route.load!(context))
        : undefined
      if (data === null) return null
      const props: PageProps<unknown> = { params: match.params, searchParams, user, data }
      return {
        key,
        pluginId,
        props,
        Component: route.component,
        metadata: async () =>
          route.metadata ? traced(`metadata ${key}`, span, () => route.metadata!(props)) : {},
      }
    },
    slot: (name) => stores.slots.get(name).map((fill) => fill.component) as never,
    handleApi: (request) =>
      dispatchApi(stores.apis, request, {
        logger,
        origins,
        userForSession: (token) => input.auth.userForSession(token),
      }),

    auth: input.auth,
    content: input.content,
    media: input.media,
    mail: input.mail,
    jobs: input.jobs,
    webhooks: input.webhooks,
    cache: input.cache,
    accounts: input.accounts,
    users: input.users,
    resolveAccount: (pathname, searchParams, user) =>
      input.resolveAccount(pathname, searchParams, user),
    maxUploadBytes: input.maxUploadBytes,
    serveUpload: (request, key) => serveUpload(input.mediaStorage(), key, request),
    can: (user, capability, ...args) => capabilities.can(user, capability, ...args),
    roles: () => capabilities.roles(),
    capabilities: () => capabilities.capabilities(),

    plugins: () =>
      options.plugins.map((plugin): PluginStatus => {
        const on = configured.has(plugin.id)
        const status = activeSet.has(plugin.id) ? 'active' : on ? 'failed' : 'inactive'
        return {
          id: plugin.id,
          name: displayName(plugin, plugin.id),
          version: plugin.version,
          description: plugin.description,
          requires: plugin.requires ?? {},
          status,
          reason:
            status === 'failed'
              ? input.skipped.find((entry) => entry.id === plugin.id)?.reason
              : undefined,
          blockers: on
            ? deactivationBlockers(plugin.id, options.plugins, configured)
            : activationBlockers(plugin, installed, configured, input.coreVersion),
        }
      }),

    settingsPage,

    async resolveAdminPage(pathname, searchParams, user) {
      const match = stores.adminPages.match(pathname)
      if (!match) return { kind: 'not-found' }
      const entry = match.route.value
      if ('settingsPage' in entry) return settingsPage(entry.settingsPage, user)
      if ('content' in entry) return contentScreen(entry.content, match.params, user)
      if ('taxonomy' in entry) return taxonomyScreen(entry.taxonomy, match.params, user)
      if ('media' in entry) return mediaScreen(entry.media, match.params, user)
      if ('user' in entry) {
        if (
          !capabilities.can(user, 'core.access_admin') ||
          !capabilities.can(user, 'core.manage_users')
        ) {
          return { kind: 'forbidden' }
        }
        const target = await input.users.get(match.params.id ?? '')
        return target ? { kind: 'user-edit', target } : { kind: 'not-found' }
      }
      const { pluginId, page } = entry
      if (
        !capabilities.can(user, 'core.access_admin') ||
        !capabilities.can(user, page.capability)
      ) {
        return { kind: 'forbidden' }
      }
      const context = { params: match.params, searchParams, user }
      let data: unknown
      try {
        data = page.load
          ? await traced(
              `load ${pluginId}.${page.name}`,
              {
                'otw.kind': 'admin',
                'otw.plugin': pluginId,
                'otw.route': `${pluginId}.${page.name}`,
              },
              () => page.load!(context),
            )
          : undefined
      } catch (error) {
        if (error instanceof ForbiddenError) return { kind: 'forbidden' }
        throw error
      }
      if (data === null) return { kind: 'not-found' }
      const props = { ...context, data }
      return {
        kind: 'page',
        key: match.route.key,
        pluginId,
        title: typeof page.title === 'function' ? page.title(props) : page.title,
        titleAction: page.titleAction?.(props) ?? null,
        props,
        Component: page.component,
      }
    },

    adminMenu: (user) =>
      stores.menu.build(user, (u, capability) => capabilities.can(u, capability)),

    contentScreens: (type) => input.contentScreens.for(type),
    resolveContent: (pathname, searchParams, user) =>
      input.resolveContent(pathname, searchParams, user),
    contentTemplate: (view, name) => input.templates.get(view, name),
    adminUrl: (name, params) => stores.adminPages.url(name, params),
    actionUrl: (pluginId, name) => actionPath(pluginId, name),
    readFlash: (value) => prepared.flash.decode(value),
  }
}
