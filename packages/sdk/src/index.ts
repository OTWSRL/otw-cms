import type { PluginDefinition, User } from './types'

export type * from './types'
export type { AdminIcon, AdminIconName } from './admin-icons'
export { ADMIN_ICON_NAMES, isAdminIcon } from './admin-icons'
export { ActionError } from './action-error'
export { ForbiddenError } from './forbidden-error'
export { HttpError } from './http-error'

/** Identity helper for type inference. The kernel validates the definition when it loads. */
export function definePlugin(definition: PluginDefinition): PluginDefinition {
  return definition
}

/*
 * Extension points. They are declared here, in the entry module, so plugins can augment them:
 *
 *   declare module '@cms/sdk' {
 *     interface Registries { 'commerce.gateways': PaymentGateway }
 *     interface Filters { 'commerce.cart.totals': [CartTotals, { lines: QuotedLine[] }] }
 *     interface Actions { 'commerce.order.paid': { order: Order } }
 *     interface Services { commerce: CommerceService }
 *     interface Settings { 'commerce.currency': string }
 *     interface Capabilities { 'commerce.manage_orders': true }
 *     interface MetaCapabilities { 'commerce.cancel_order': [order: Order] }
 *     interface Slots { 'commerce.admin.order': { order: Order; user: User } }
 *   }
 *
 * Names are namespaced with the owning plugin's id to avoid collisions.
 */

/** Registry name -> item type. Items must have a string `id`. */
export interface Registries {}

/** Filter name -> `[value, context]`. Handlers receive the value and return a replacement. */
export interface Filters {}

/** Action name -> payload. */
export interface Actions {}

/** Service name -> the API the providing plugin exposes to others. */
export interface Services {}

/** Setting key -> value type. Declare the field itself in the plugin's `settings`. */
export interface Settings {
  'site.title': string
  'site.url': string
  'site.locale': string
}

/** Capability name -> `true`. Admin pages and actions each require one. */
export interface Capabilities {
  'core.access_admin': true
  'core.manage_plugins': true
  'core.manage_settings': true
  'core.manage_users': true
  'core.manage_updates': true
}

/**
 * Meta capability name -> the arguments it is checked against. Like WordPress's `edit_post`,
 * it maps an object to the primitive capabilities it requires: `can(user, 'commerce.cancel_order', order)`.
 */
export interface MetaCapabilities {}

/** Slot name -> the props each fill receives. */
export interface Slots {
  'header.nav': Record<string, never>
  /** Top of every admin screen. */
  'admin.notices': { user: User }
  /** Widgets on the admin dashboard. */
  'admin.dashboard': { user: User }
}

export type RegistryName = keyof Registries & string
export type FilterName = keyof Filters & string
export type ActionName = keyof Actions & string
export type ServiceName = keyof Services & string
export type SettingName = keyof Settings & string
export type CapabilityName = keyof Capabilities & string
export type MetaCapabilityName = keyof MetaCapabilities & string
export type SlotName = keyof Slots & string

/** Arguments a capability check takes: none for primitive capabilities. */
export type CapabilityArgs<C extends string> = C extends MetaCapabilityName
  ? MetaCapabilities[C]
  : []

export type FilterValue<K extends FilterName> = Filters[K] extends [infer V, unknown] ? V : never
export type FilterContext<K extends FilterName> = Filters[K] extends [unknown, infer C] ? C : never

export type SettingsValues = { [K in SettingName]?: Settings[K] }
