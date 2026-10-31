import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import type { ReactNode } from 'react'
import type {
  ActionName,
  Actions,
  CapabilityName,
  FilterContext,
  FilterName,
  FilterValue,
  Registries,
  RegistryName,
  ServiceName,
  Services,
  SettingName,
  Settings,
} from './index'

/** Works with any Drizzle Postgres driver (node-postgres in production, PGlite in dev and tests). */
export type Database = PgDatabase<PgQueryResultHKT, Record<string, never>>

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void
  info(message: string, context?: Record<string, unknown>): void
  warn(message: string, context?: Record<string, unknown>): void
  error(message: string, context?: Record<string, unknown>): void
}

// ── Hooks ────────────────────────────────────────────────────────────────────

export interface HookOptions {
  /** Lower runs first. Defaults to 10, as in WordPress. */
  priority?: number
}

export type FilterHandler<K extends FilterName> = (
  value: FilterValue<K>,
  context: FilterContext<K>,
) => FilterValue<K> | Promise<FilterValue<K>>

export type ActionHandler<K extends ActionName> = (payload: Actions[K]) => void | Promise<void>

export interface HooksApi {
  addFilter<K extends FilterName>(name: K, handler: FilterHandler<K>, options?: HookOptions): void
  applyFilters<K extends FilterName>(
    name: K,
    value: FilterValue<K>,
    context: FilterContext<K>,
  ): Promise<FilterValue<K>>
  addAction<K extends ActionName>(name: K, handler: ActionHandler<K>, options?: HookOptions): void
  /**
   * Runs every handler. A failing handler is logged and skipped so one broken plugin can't
   * block the others; inside a transaction each handler runs in its own savepoint.
   */
  doAction<K extends ActionName>(name: K, payload: Actions[K]): Promise<void>
}

// ── Registries & services ────────────────────────────────────────────────────

export interface RegistryItem {
  id: string
}

export interface Registry<T extends RegistryItem> {
  add(item: T): void
  get(id: string): T | undefined
  has(id: string): boolean
  /** Items in registration order, which follows plugin load order. */
  list(): T[]
}

export type RegistryOf<K extends RegistryName> = Registry<Extract<Registries[K], RegistryItem>>

export interface RegistriesApi {
  /** Called once by the owning plugin. Other plugins can only add to defined registries. */
  define<K extends RegistryName>(name: K): RegistryOf<K>
  get<K extends RegistryName>(name: K): RegistryOf<K>
}

export interface ServicesApi {
  provide<K extends ServiceName>(name: K, service: Services[K]): void
  get<K extends ServiceName>(name: K): Services[K]
}

export interface SettingsApi {
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

export interface TextSetting extends SettingFieldBase {
  type: 'text'
  default?: string
  /** Defaults to 500. */
  maxLength?: number
  /** Return an error message to reject the (trimmed) value. */
  validate?: (value: string) => string | null
}

export interface BooleanSetting extends SettingFieldBase {
  type: 'boolean'
  default?: boolean
}

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

export type SettingDefinition = TextSetting | BooleanSetting | SelectSetting | SecretSetting

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

export interface User {
  id: string
  email: string
  name: string
  role: string
}

export interface RoleDefinition {
  label: string
  capabilities?: readonly CapabilityName[]
}

export interface CapabilityDefinition {
  label: string
  /** Existing roles that get this capability. Administrators have every capability. */
  roles?: readonly string[]
}

export interface AuthApi {
  /** Adds a role, like WordPress's `add_role()`. */
  role(id: string, definition: RoleDefinition): void
  /** Declares one of this plugin's capabilities. Names start with the plugin's id. */
  capability(name: CapabilityName, definition: CapabilityDefinition): void
  can(user: User | null, capability: CapabilityName): boolean
}

// ── Admin ────────────────────────────────────────────────────────────────────

export interface AdminPageContext {
  params: Record<string, string>
  searchParams: SearchParams
  user: User
}

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
  menu?: { label: string; order?: number }
  /** Return `null` to render a 404. */
  load?: (context: AdminPageContext) => TData | null | Promise<TData | null>
  component: (props: AdminPageProps<TData>) => ReactNode | Promise<ReactNode>
}

export interface AdminActionContext {
  user: User
  form: FormData
}

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

export interface AdminApi {
  page<TData = undefined>(page: AdminPage<TData>): void
  action(action: AdminAction): void
  /** URL of any plugin's admin page by qualified name, e.g. `commerce.products`. */
  url(name: string, params?: Record<string, string>): string
  /** Form `action` URL for one of this plugin's admin actions. */
  actionUrl(name: string): string
}

// ── Routes & slots ───────────────────────────────────────────────────────────

export type SearchParams = Record<string, string | string[] | undefined>

export interface PageContext {
  params: Record<string, string>
  searchParams: SearchParams
}

export interface PageProps<TData> extends PageContext {
  data: TData
}

export interface PageMetadata {
  title?: string
  description?: string
}

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

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface ApiContext {
  params: Record<string, string>
}

export type ApiHandler = (request: Request, context: ApiContext) => Response | Promise<Response>

export interface ApiRoute {
  method: HttpMethod
  /** Mounted under `/api/p/{pluginId}`. */
  path: string
  handler: ApiHandler
}

export interface RoutesApi {
  page<TData = undefined>(route: PageRoute<TData>): void
  api(route: ApiRoute): void
  /** Builds the public URL of any page route by its qualified name, honouring site overrides. */
  url(name: string, params?: Record<string, string>): string
  /** Public URL of one of this plugin's API routes. */
  apiUrl(path: string): string
}

export type SlotComponent = () => ReactNode | Promise<ReactNode>

export interface SlotsApi {
  fill(name: string, fill: { component: SlotComponent; priority?: number }): void
}

// ── Plugins ──────────────────────────────────────────────────────────────────

export interface Migration {
  /** Unique within the plugin. Applied in array order, once. */
  id: string
  up: (db: Database) => Promise<unknown>
}

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
  setup?: (cms: PluginContext) => void | Promise<void>
}
