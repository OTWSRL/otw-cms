import { definePlugin } from '@otwdesign/sdk'

// The e2e tests' second plugin: it needs the Library, as a payment plugin needs a shop, and its
// key comes from the server environment.

declare module '@otwdesign/sdk' {
  interface Settings {
    /** From `COURIER_API_KEY` only; the e2e server has none. */
    'courier.apiKey': string
  }
}

/** The codes the fixture's sign-in step accepts. */
export const APP_CODE = '246810'
export const EMAIL_CODE = '135790'

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
  setup(cms) {
    // A sign-in step for the e2e tests, in miniature: only addresses that start with `twostep`
    // are asked, for a fixed code from their "app" or one sent by email.
    const remembered = new Map<string, string>()
    cms.auth.signInStep({
      methods(user, { device }) {
        if (!user.email.startsWith('twostep')) return []
        if (device && remembered.get(device) === user.id) return []
        return [
          {
            id: 'app',
            label: 'Authenticator app',
            prompt: 'Enter the 6-digit code from your authenticator app.',
            numeric: true,
          },
          {
            id: 'email',
            label: 'Email me a code',
            prompt: `Enter the code we emailed to ${user.email}.`,
            sends: true,
            numeric: true,
          },
        ]
      },
      async send(user) {
        await cms.mail.send({
          to: user.email,
          subject: 'Your sign-in code',
          text: `Your code is ${EMAIL_CODE}.`,
        })
      },
      verify: (_user, method, code) => code === (method === 'app' ? APP_CODE : EMAIL_CODE),
      rememberDays: () => 30,
      remember(user, device) {
        remembered.set(device, user.id)
      },
    })
  },
})
