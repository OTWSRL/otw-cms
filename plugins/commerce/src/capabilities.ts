import type { PluginContext } from '@otwdesign/sdk'

/**
 * The shop manager role and Commerce's capabilities. Registered by the main entry, so the
 * storefront, the API and the admin agree on who may do what.
 */
export function registerCapabilities(cms: PluginContext, manualGatewayId: string): void {
  cms.auth.role('shop_manager', { label: 'Shop manager', capabilities: ['core.access_admin'] })
  cms.auth.capability('commerce.manage_products', {
    label: 'Manage products',
    roles: ['shop_manager'],
  })
  cms.auth.capability('commerce.manage_orders', { label: 'Manage orders', roles: ['shop_manager'] })
  cms.auth.capability('commerce.manage_settings', {
    label: 'Change shop settings',
    roles: ['shop_manager'],
  })
  cms.auth.metaCapability('commerce.mark_order_paid', {
    label: 'Mark an order as paid',
    map: (_user, order) =>
      order.status === 'pending' && order.gateway === manualGatewayId
        ? ['commerce.manage_orders']
        : false,
  })
  cms.auth.metaCapability('commerce.cancel_order', {
    label: 'Cancel an order',
    map: (_user, order) => (order.status === 'pending' ? ['commerce.manage_orders'] : false),
  })
}
