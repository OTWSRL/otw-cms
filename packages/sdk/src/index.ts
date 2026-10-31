import type { PluginDefinition } from './types'

export type * from './types'
export { ActionError } from './action-error'
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
}

export type RegistryName = keyof Registries & string
export type FilterName = keyof Filters & string
export type ActionName = keyof Actions & string
export type ServiceName = keyof Services & string
export type SettingName = keyof Settings & string
export type CapabilityName = keyof Capabilities & string

export type FilterValue<K extends FilterName> = Filters[K] extends [infer V, unknown] ? V : never
export type FilterContext<K extends FilterName> = Filters[K] extends [unknown, infer C] ? C : never

export type SettingsValues = { [K in SettingName]?: Settings[K] }
