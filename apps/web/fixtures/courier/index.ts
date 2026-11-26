import { ActionError, definePlugin } from '@otwdesign/sdk'

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

    // A sign-in provider for the e2e tests, in miniature. Its "service" is a page of this
    // fixture that asks who you are and sends you back with that address as the code.
    cms.auth.signInProvider({
      id: 'courier',
      label: 'Continue with Courier',
      name: 'Courier',
      // A parcel, in a square.
      image: `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18"><path d="M2 2h14v14H2z"/></svg>').toString('base64')}`,
      start({ redirectUri, state }) {
        const who = new URL(cms.routes.apiUrl('/who'), redirectUri)
        who.searchParams.set('state', state)
        who.searchParams.set('redirect_uri', redirectUri)
        return who.href
      },
      finish({ params }) {
        const email = params.get('code') ?? ''
        if (params.get('error')) throw new ActionError('You didn’t allow it at Courier.')
        return {
          subject: `courier-${email}`,
          email,
          emailVerified: !email.startsWith('unverified'),
          // The pretend service hosts example.com's mailboxes, and no others.
          emailOwned: email.endsWith('@example.com'),
          name: 'Courier Person',
        }
      },
      newAccountRole: () => 'customer',
    })
    cms.routes.api({
      method: 'GET',
      path: '/who',
      handler(request) {
        const url = new URL(request.url)
        const back = url.searchParams.get('redirect_uri') ?? ''
        const state = url.searchParams.get('state') ?? ''
        const text = (value: string) =>
          value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)
        // Only back to this site: the page is a stand-in, not a redirector.
        if (!back.startsWith(`${url.origin}/`)) return new Response('Bad address', { status: 400 })
        return new Response(
          `<!doctype html><title>Courier sign-in</title><h1>Courier</h1>
<form method="get" action="${text(back)}">
<input type="hidden" name="state" value="${text(state)}">
<label>Your Courier address <input type="email" name="code" required></label>
<button>Allow</button>
<button name="error" value="access_denied" formnovalidate>Cancel</button>
</form>`,
          { headers: { 'content-type': 'text/html; charset=utf-8' } },
        )
      },
    })
  },
})
