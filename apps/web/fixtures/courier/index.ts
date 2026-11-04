import { definePlugin } from '@otwdesign/sdk'

// The e2e tests' second plugin: it needs the Library, as a payment plugin needs a shop, and its
// key comes from the server environment.

declare module '@otwdesign/sdk' {
  interface Settings {
    /** From `COURIER_API_KEY` only; the e2e server has none. */
    'courier.apiKey': string
  }
}

export default definePlugin({
  id: 'courier',
  version: '1.0.0',
  name: 'Courier',
  description: 'Delivers library books, once its key is set. For the e2e tests.',
  requires: { core: '^1.0.0', library: '^1.0.0' },
  settings: {
    'courier.apiKey': {
      type: 'secret',
      label: 'API key',
      description: 'From the courier’s dashboard.',
      env: 'COURIER_API_KEY',
    },
  },
  setup() {},
})
