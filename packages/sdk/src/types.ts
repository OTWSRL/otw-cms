import type { AdminIcon } from './admin-icons'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import type { ReactNode } from 'react'
import type {
  ActionName,
  Actions,
  CapabilityArgs,
  CapabilityName,
  FilterContext,
  FilterName,
  FilterValue,
  MetaCapabilities,
  MetaCapabilityName,
  Registries,
  RegistryName,
  ServiceName,
  Services,
  SettingName,
  Settings,
  SlotName,
  Slots,
} from './index'

/** Works with any Drizzle Postgres driver (node-postgres in production, PGlite in dev and tests). */
export type Database = PgDatabase<PgQueryResultHKT, Record<string, never>>

/** The plugin's logger: each entry carries the plugin's id, and context is logged as data. */
export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void
  info(message: string, context?: Record<string, unknown>): void
  warn(message: string, context?: Record<string, unknown>): void
  error(message: string, context?: Record<string, unknown>): void
}

// ── Hooks ────────────────────────────────────────────────────────────────────

/** How a handler is added to a hook. */
export interface HookOptions {
  /** Lower runs first. Defaults to 10, as in WordPress. */
  priority?: number
}

/** Receives the value and the filter's context, and returns the value (changed or not). */
export type FilterHandler<K extends FilterName> = (
  value: FilterValue<K>,
  context: FilterContext<K>,
) => FilterValue<K> | Promise<FilterValue<K>>

/** Receives the action's payload. Its return value is ignored. */
export type ActionHandler<K extends ActionName> = (payload: Actions[K]) => void | Promise<void>

/** `cms.hooks`: WordPress's actions and filters, typed by the `Actions` and `Filters` interfaces. */
export interface HooksApi {
  /** Adds a handler to a filter, like `add_filter()`. */
  addFilter<K extends FilterName>(name: K, handler: FilterHandler<K>, options?: HookOptions): void
  /**
   * Passes `value` through every handler in priority order, like `apply_filters()`, and returns
   * the result. A handler that throws fails the whole call.
   */
  applyFilters<K extends FilterName>(
    name: K,
    value: FilterValue<K>,
    context: FilterContext<K>,
  ): Promise<FilterValue<K>>
  /** Adds a handler to an action, like `add_action()`. */
  addAction<K extends ActionName>(name: K, handler: ActionHandler<K>, options?: HookOptions): void
  /**
   * Runs every handler. A failing handler is logged and skipped so one broken plugin can't
   * block the others; inside a transaction each handler runs in its own savepoint.
   */
  doAction<K extends ActionName>(name: K, payload: Actions[K]): Promise<void>
}

// ── Registries & services ────────────────────────────────────────────────────

/** What every registry item has: an id, unique within its registry. */
export interface RegistryItem {
  id: string
}

/** A list one plugin owns and others add to, such as Commerce's payment gateways. */
export interface Registry<T extends RegistryItem> {
  /** Adds an item during setup. An id the registry already has throws. */
  add(item: T): void
  get(id: string): T | undefined
  has(id: string): boolean
  /** Items in registration order, which follows plugin load order. */
  list(): T[]
}

/** The registry declared under a name, typed by its item. */
export type RegistryOf<K extends RegistryName> = Registry<Extract<Registries[K], RegistryItem>>

/** `cms.registries`: defines a plugin's own registries and reaches other plugins'. */
export interface RegistriesApi {
  /** Called once by the owning plugin. Other plugins can only add to defined registries. */
  define<K extends RegistryName>(name: K): RegistryOf<K>
  /** A registry another plugin defined. Throws if it isn't defined: require its owner, or use `when()`. */
  get<K extends RegistryName>(name: K): RegistryOf<K>
}

/** `cms.services`: APIs plugins offer one another, typed by the `Services` interface. */
export interface ServicesApi {
  /** Offers this plugin's service under its name. One plugin provides each; a second throws. */
  provide<K extends ServiceName>(name: K, service: Services[K]): void
  /** Another plugin's service. Throws if no active plugin provides it: require it, or use `when()`. */
  get<K extends ServiceName>(name: K): Services[K]
}

/** `cms.settings`: reads any setting, already resolved from code, environment, database and default. */
export interface SettingsApi {
  /** The setting's value, or `undefined` when it has none and no default. */
  get<K extends SettingName>(key: K): Settings[K] | undefined
}

// ── Settings fields ──────────────────────────────────────────────────────────

interface SettingFieldBase {
  label: string
  description?: string
  /**
   * Environment variable that overrides the stored value. The admin shows the field read-only
   * while it is set, as WordPress does for constants in wp-config.php.
   */
  env?: string
}

/** A line of text, trimmed when saved. */
export interface TextSetting extends SettingFieldBase {
  type: 'text'
  default?: string
  /** Defaults to 500. */
  maxLength?: number
  /** Return an error message to reject the (trimmed) value. */
  validate?: (value: string) => string | null
}

/** A checkbox. */
export interface BooleanSetting extends SettingFieldBase {
  type: 'boolean'
  default?: boolean
}

/** A choice from a fixed list. */
export interface SelectSetting extends SettingFieldBase {
  type: 'select'
  options: readonly { value: string; label: string }[]
  default?: string
}

/** Read from the environment only. Secrets are never stored in the database or shown. */
export interface SecretSetting extends SettingFieldBase {
  type: 'secret'
  env: string
}

/** One field in a plugin's `settings`. */
export type SettingDefinition = TextSetting | BooleanSetting | SelectSetting | SecretSetting

/** The fields that can hold a value of type `V`: a checkbox for booleans, the rest for strings. */
export type SettingDefinitionFor<V> = [V] extends [boolean]
  ? BooleanSetting
  : [V] extends [string]
    ? TextSetting | SelectSetting | SecretSetting
    : never

/** Keys must start with the plugin's id, e.g. `commerce.currency`. */
export type SettingDefinitions = {
  readonly [K in SettingName]?: SettingDefinitionFor<Settings[K]>
}

// ── Users & capabilities ─────────────────────────────────────────────────────

/** A signed-in person, as admin pages, actions and capability checks receive them. */
export interface User {
  id: string
  email: string
  name: string
  role: string
}

/** A role's label and the capabilities it starts with. */
export interface RoleDefinition {
  label: string
  capabilities?: readonly CapabilityName[]
}

/** How a capability shows in the admin, and which roles start with it. */
export interface CapabilityDefinition {
  label: string
  /** Existing roles that get this capability. Administrators have every capability. */
  roles?: readonly string[]
}

/**
 * The primitive capabilities a check requires: the user needs every one. `false` denies everyone,
 * administrators included, like WordPress's `do_not_allow`.
 */
export type RequiredCapabilities = readonly [CapabilityName, ...CapabilityName[]] | false

/** A meta capability's label and how it maps an object to the capabilities it needs. */
export interface MetaCapabilityDefinition<K extends MetaCapabilityName> {
  label: string
  /**
   * Like `map_meta_cap`. Receives the loaded object, not an id, so checks stay synchronous and a
   * list screen can check every row without a query each.
   */
  map: (user: User, ...args: MetaCapabilities[K]) => RequiredCapabilities
}

/** Adjusts another plugin's meta capability, like the `map_meta_cap` filter. */
export type CapabilityExtension<K extends MetaCapabilityName> = (
  required: RequiredCapabilities,
  user: User,
  ...args: MetaCapabilities[K]
) => RequiredCapabilities

/**
 * `cms.auth`: roles, capabilities and checks, as in WordPress. Add and change roles and
 * capabilities in `setup()`, so every part of the site agrees on them; checks work anywhere.
 */
export interface AuthApi {
  /** Adds a role, like WordPress's `add_role()`. */
  role(id: string, definition: RoleDefinition): void
  /** Declares one of this plugin's capabilities. Names start with the plugin's id. */
  capability(name: CapabilityName, definition: CapabilityDefinition): void
  /**
   * Gives any role (including other plugins' roles) these capabilities, like `add_cap()`. Applied
   * once every plugin has set up; a grant to a role no active plugin defines is dropped.
   */
  grant(role: string, capabilities: readonly CapabilityName[]): void
  /** Takes capabilities away from a role, like `remove_cap()`. Applied after every grant. */
  revoke(role: string, capabilities: readonly CapabilityName[]): void
  /** Declares one of this plugin's meta capabilities. Names start with the plugin's id. */
  metaCapability<K extends MetaCapabilityName>(
    name: K,
    definition: MetaCapabilityDefinition<K>,
  ): void
  /** Runs after the owner's `map` (and earlier extensions), in load order. */
  extendCapability<K extends MetaCapabilityName>(name: K, extension: CapabilityExtension<K>): void
  /**
   * Whether `user` may do something, like `current_user_can()`. A meta capability takes the object
   * it's checked against. `null` (signed out) has no capabilities.
   */
  can<C extends CapabilityName | MetaCapabilityName>(
    user: User | null,
    capability: C,
    ...args: CapabilityArgs<C>
  ): boolean
}

// ── Admin ────────────────────────────────────────────────────────────────────

/** A core menu section, or a plugin id to join that plugin's section (`add_submenu_page`). */
export type AdminMenuParent = 'dashboard' | 'plugins' | 'users' | 'settings' | (string & {})

/** Where an admin page shows in the menu. */
export interface AdminMenuPlacement {
  label: string
  /** Lower comes first. Defaults to 10. */
  order?: number
  /**
   * Defaults to this plugin's own section. A plugin id that isn't active falls back to it too,
   * so pages placed under an optional dependency still show.
   */
  parent?: AdminMenuParent
}

/** What an admin page's `load` receives. */
export interface AdminPageContext {
  params: Record<string, string>
  searchParams: SearchParams
  user: User
}

/** What an admin page's `component`, `title` and `titleAction` receive: the context and what `load` returned. */
export interface AdminPageProps<TData> extends AdminPageContext {
  data: TData
}

/**
 * TypeScript infers `TData` from `load`, reading the object left to right: write `load` before
 * `title` and `component`, or their `data` is typed `undefined`.
 */
export interface AdminPage<TData = undefined> {
  /** Unique within the plugin. Addressed globally as `${pluginId}.${name}`. */
  name: string
  /** Mounted under `/admin/{pluginId}`, so `/products` serves `/admin/commerce/products`. */
  path: string
  title: string | ((props: AdminPageProps<TData>) => string)
  capability: CapabilityName
  /** Adds the page to the admin menu. Leave it out for pages reached from others (edit forms). */
  menu?: AdminMenuPlacement
  /** Return `null` to render a 404. */
  load?: (context: AdminPageContext) => TData | null | Promise<TData | null>
  /** A button beside the title, such as "Add Product" on a list (`page-title-action`). */
  titleAction?: (props: AdminPageProps<TData>) => AdminTitleAction | null
  component: (props: AdminPageProps<TData>) => ReactNode | Promise<ReactNode>
}

/** The button beside an admin page's title. */
export interface AdminTitleAction {
  label: string
  url: string
}

/** What an admin action's handler receives: who posted the form, and what it sent. */
export interface AdminActionContext {
  user: User
  form: FormData
}

/** Where an admin action sends the user next, and what it tells them. */
export interface AdminActionResult {
  /** Same-site path to go to next. Defaults to the page that posted the form. */
  redirect?: string
  /** Shown once on the next page. */
  notice?: string
}

/**
 * A form post from the admin. The kernel checks the origin, the session and the capability
 * before the handler runs, and turns the result into a redirect.
 */
export interface AdminAction {
  name: string
  capability: CapabilityName
  handler: (
    context: AdminActionContext,
  ) => AdminActionResult | void | Promise<AdminActionResult | void>
}

/** A settings screen, like `add_options_page()` or a WooCommerce settings tab. */
export interface SettingsPage {
  /** Unique among this plugin's admin pages. Addressed globally as `${pluginId}.${name}`. */
  name: string
  /** Mounted under `/admin/{pluginId}`, like other admin pages. */
  path: string
  title: string
  description?: string
  /** Who may open and save it. Defaults to `core.manage_settings`. */
  capability?: CapabilityName
  /** Listed under Settings with `title` as its label unless this says otherwise. */
  menu?: Partial<AdminMenuPlacement>
}

/** A group of fields on any settings page, including other plugins' (`add_settings_section`). */
export interface SettingsSection {
  /** Unique within the plugin. Addressed globally as `${pluginId}.${name}`. */
  name: string
  /**
   * Qualified page name, such as `core.general` or `commerce.payments`. If that plugin isn't
   * active, the section moves to this plugin's own settings page.
   */
  page: string
  title: string
  description?: string
  /** Lower comes first. Defaults to 10. */
  order?: number
  /** This plugin's own settings, in display order. */
  fields: readonly SettingName[]
}

/** Adds this plugin's settings to another plugin's section (`add_settings_field`). */
export interface SettingsFields {
  /** Qualified section name, such as `core.site`. */
  section: string
  fields: readonly SettingName[]
}

/**
 * `cms.admin`: this plugin's admin pages, form actions and settings screens. Register them in the
 * plugin's admin entry (`defineAdmin`), which only the admin loads; `url()` and `actionUrl()` work
 * anywhere.
 */
export interface AdminApi {
  /** Adds an admin page, like `add_menu_page()` or `add_submenu_page()`. */
  page<TData = undefined>(page: AdminPage<TData>): void
  /** Adds a form action, posted to `actionUrl(name)`. */
  action(action: AdminAction): void
  /**
   * Settings stay declared on the plugin definition; these say where they show. Fields this
   * plugin doesn't place get a section on its first settings page, or on one made for it.
   */
  settingsPage(page: SettingsPage): void
  settingsSection(section: SettingsSection): void
  settingsFields(fields: SettingsFields): void
  /**
   * URL of an admin page. By qualified name, such as `commerce.products`, where the admin is
   * loaded: its screens, and API routes. By path, relative to this plugin's admin pages, such as
   * `/orders/:id`, anywhere, the site included, like WordPress's `admin_url()`.
   */
  url(name: string, params?: Record<string, string>): string
  /** Form `action` URL for one of this plugin's admin actions. */
  actionUrl(name: string): string
}

// ── Routes & slots ───────────────────────────────────────────────────────────

/** A URL's query string, as Next.js passes it: repeated keys become arrays. */
export type SearchParams = Record<string, string | string[] | undefined>

/** What a page route's `load` receives: the path's parameters and the query string. */
export interface PageContext {
  params: Record<string, string>
  searchParams: SearchParams
}

/** What a page route's `component` and `metadata` receive: the context and what `load` returned. */
export interface PageProps<TData> extends PageContext {
  data: TData
}

/** The page's `<title>` and meta description. */
export interface PageMetadata {
  title?: string
  description?: string
}

/**
 * A page on the site, served by the site's catch-all route. TypeScript infers `TData` from `load`:
 * write `load` before `metadata` and `component`.
 */
export interface PageRoute<TData = undefined> {
  /** Unique within the plugin. Addressed globally as `${pluginId}.${name}`. */
  name: string
  /** Default path such as `/product/:slug`. Sites can override it without touching the plugin. */
  path: string
  /** Return `null` to render a 404. */
  load?: (context: PageContext) => TData | null | Promise<TData | null>
  metadata?: (props: PageProps<TData>) => PageMetadata | Promise<PageMetadata>
  component: (props: PageProps<TData>) => ReactNode | Promise<ReactNode>
}

/** The methods an API route can answer. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** What an API route's handler receives besides the request. */
export interface ApiContext {
  /** The path's parameters, such as `id` for `/orders/:id`. */
  params: Record<string, string>
  /**
   * The user signed in with the request's session cookie, or `null`, looked up on the first call.
   * Unsafe requests (POST, PUT, PATCH, DELETE) count as signed in only when they carry this site's
   * `Origin`, which browsers send, so another site can't act as the user.
   */
  user(): Promise<User | null>
}

/** Answers an API request with a standard `Response`. */
export type ApiHandler = (request: Request, context: ApiContext) => Response | Promise<Response>

/** An HTTP endpoint for the site's pages, other servers, or scripts. */
export interface ApiRoute {
  method: HttpMethod
  /** Mounted under `/api/p/{pluginId}`. */
  path: string
  handler: ApiHandler
}

/** `cms.routes`: this plugin's pages on the site and its API endpoints. */
export interface RoutesApi {
  /** Adds a page to the site. */
  page<TData = undefined>(route: PageRoute<TData>): void
  /** Adds an API endpoint under `/api/p/{pluginId}`. */
  api(route: ApiRoute): void
  /** Builds the public URL of any page route by its qualified name, honouring site overrides. */
  url(name: string, params?: Record<string, string>): string
  /** Public URL of one of this plugin's API routes. */
  apiUrl(path: string): string
}

/** A component that fills a slot: it receives the slot's props. */
export type SlotComponent<K extends SlotName = SlotName> = (
  props: Slots[K],
) => ReactNode | Promise<ReactNode>

/** `cms.slots`: renders components in other plugins' slots, and reads the fills of this plugin's own. */
export interface SlotsApi {
  /**
   * Renders `component` wherever the slot is shown. Lower `priority` comes first; defaults to 10.
   * Fill admin slots (`admin.*`, and plugins' `*.admin.*`) in the admin entry, the site's in
   * `setup()`.
   */
  fill<K extends SlotName>(name: K, fill: { component: SlotComponent<K>; priority?: number }): void
  /**
   * The fills for a slot, in priority order, for plugins that offer a slot on their own screens.
   * Call it while rendering: fills from plugins loaded later aren't registered during setup.
   */
  get<K extends SlotName>(name: K): SlotComponent<K>[]
}

// ── Tracing ──────────────────────────────────────────────────────────────────

/** What a span in a request's trace timed. */
export type TraceSpanKind =
  | 'request'
  | 'render'
  | 'query'
  | 'hook'
  | 'page'
  | 'admin'
  | 'api'
  | 'boot'
  | 'setup'
  | 'migration'
  | 'other'

/** One timed piece of a request: Next.js's own work, or the CMS's and its plugins'. */
export interface TraceSpan {
  id: string
  /** The span it ran inside; `null` for the request itself. */
  parentId: string | null
  name: string
  kind: TraceSpanKind
  /** Milliseconds after the request started. */
  start: number
  /** Milliseconds. */
  duration: number
  /** The plugin it ran for: its own, or that of the nearest span around it that has one. */
  plugin: string | null
  /** OpenTelemetry attributes, such as `db.statement` on a query. Query values are never recorded. */
  attributes: Readonly<Record<string, string | number | boolean>>
  /** The error it ended with, if it failed. */
  error?: string
}

/** Everything one request did on the server, from when it arrived to when its response ended. */
export interface RequestTrace {
  /** The OpenTelemetry trace id. */
  id: string
  method: string
  /** The route that answered, such as `/[...slug]`, when Next.js says. */
  route: string | null
  path: string | null
  status: number | null
  /** When the request arrived, in milliseconds since the epoch. */
  startedAt: number
  /** Milliseconds from arrival to the end of the response; `null` while it's still running. */
  duration: number | null
  /** The server process's memory when the response ended, in bytes. */
  memory: { heapUsed: number; rss: number } | null
  /** In the order they started. */
  spans: readonly TraceSpan[]
  /** Spans left out because the request had more than the limit. */
  droppedSpans: number
}

/**
 * `cms.traces`: what each request did on the server, as OpenTelemetry traces. Nothing is
 * recorded until an active plugin calls `enable()`, and the site must load the CMS's
 * instrumentation (`cms generate` writes `instrumentation.ts`).
 */
export interface TracesApi {
  /** Records every request while this plugin is active. Call it in `setup()`. */
  enable(): void
  /** Whether requests are being recorded: enabled, and the site's instrumentation loaded. */
  readonly available: boolean
  /** The current request's trace id, while it's being recorded. */
  currentId(): string | undefined
  /**
   * Keeps this request's trace for `get()` once the response ends. Traces nobody keeps are dropped
   * when their request ends; kept ones are held in memory for a while (the last 100, 10 minutes).
   */
  keep(id: string): void
  /** A kept trace, finished or still running. */
  get(id: string): RequestTrace | undefined
  /** Every kept trace, newest first. */
  list(): RequestTrace[]
}

// ── Plugins ──────────────────────────────────────────────────────────────────

/** A change to the database, run once and recorded so it never runs twice. */
export interface Migration {
  /** Unique within the plugin. Applied in array order, once. */
  id: string
  up: (db: Database) => Promise<unknown>
}

/** What a plugin's `setup(cms)` receives: every API it registers with. */
export interface PluginContext {
  readonly plugin: { readonly id: string; readonly version: string }
  readonly hooks: HooksApi
  readonly registries: RegistriesApi
  readonly services: ServicesApi
  readonly routes: RoutesApi
  readonly slots: SlotsApi
  readonly settings: SettingsApi
  readonly auth: AuthApi
  readonly admin: AdminApi
  readonly traces: TracesApi
  readonly logger: Logger
  /**
   * The current transaction when called inside `transaction()`, otherwise the root connection.
   * Always read it at call time; never store it in setup.
   */
  readonly db: Database
  transaction<T>(fn: (db: Database) => Promise<T>): Promise<T>
  /**
   * Runs `fn` only if `pluginId` is active and loaded before this plugin. The dependency must
   * be declared in `requires` or `optional`.
   */
  when(pluginId: string, fn: () => void | Promise<void>): Promise<void>
  isActive(pluginId: string): boolean
}

/** A plugin: what it is, what it needs, and what it sets up. Pass it to `definePlugin()`. */
export interface PluginDefinition {
  /** Lowercase kebab-case, unique across the site. */
  id: string
  /** Semver. */
  version: string
  /** Shown in the admin. Defaults to the id. */
  name?: string
  description?: string
  /** Hard dependencies: plugin id (or `core`) -> semver range. */
  requires?: Readonly<Record<string, string>>
  /** Soft dependencies: loaded first when present; use `when()` to integrate. */
  optional?: Readonly<Record<string, string>>
  migrations?: readonly Migration[]
  /** Declared up front so the admin can show them and values resolve before `setup()` runs. */
  settings?: SettingDefinitions
  /** Beside the plugin's section in the admin menu. Defaults to `admin`, a gear. */
  icon?: AdminIcon
  /**
   * Registers what every part of the site needs: hooks, services, routes, site slots, roles and
   * capabilities. Runs on every boot, after the plugins it depends on, and after its migrations.
   * Admin pages, actions, settings screens and admin slots go in the plugin's admin entry.
   */
  setup?: (cms: PluginContext) => void | Promise<void>
}

/**
 * A plugin's admin entry: what only the admin shows. The plugin's package exports it as
 * `./admin`, and `cms generate` loads it where the admin is and nowhere else, so its components,
 * and the browser code they bring, never reach the site's visitors.
 */
export interface AdminDefinition {
  /** The plugin it belongs to: its main entry's definition. */
  plugin: PluginDefinition
  /**
   * Registers admin pages, form actions, settings screens and fills for admin slots. Runs after
   * every plugin's `setup()`, in the same order, so it can use any plugin's services.
   */
  setup: (cms: PluginContext) => void | Promise<void>
}
