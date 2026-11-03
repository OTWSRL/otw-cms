import type { AccountTemplateProps, AccountView, SearchParams, User } from '@otwdesign/sdk'
import { safeRedirectPath } from './admin'
import { ACCOUNT_PATH, type AccountService } from './accounts'
import type { Flash } from './flash'
import type { UsersService } from './users'

/** The account pages' paths, by view; `/account` is sign-in or the account, by who's asking. */
const PAGES: Readonly<Record<string, AccountView>> = {
  [ACCOUNT_PATH]: 'account',
  [`${ACCOUNT_PATH}/lost-password`]: 'lost-password',
  [`${ACCOUNT_PATH}/reset`]: 'reset',
  [`${ACCOUNT_PATH}/email`]: 'confirm-email',
}

const TITLES: Readonly<Record<AccountView, string>> = {
  'sign-in': 'Sign in',
  account: 'Your account',
  'lost-password': 'Lost password',
  reset: 'Set your password',
  'confirm-email': 'Confirm your email address',
}

/** The account page at a path, with what its template needs, for whoever's asking. */
export interface AccountResolution {
  props: AccountTemplateProps
  metadata: { title: string; noindex: true; referrer: 'same-origin' | null }
}

export interface AccountPagesOptions {
  accounts: AccountService
  users: UsersService
  canUseAdmin(user: User): boolean
  actionUrl(name: string): string
  readFlash(value: string | string[] | undefined): Flash | null
}

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)

/** WooCommerce's My Account pages, for the site's catch-all route, after plugins' pages. */
export function createAccountPages(options: AccountPagesOptions) {
  const { accounts } = options
  return async function resolveAccount(
    pathname: string,
    searchParams: SearchParams,
    user: User | null,
  ): Promise<AccountResolution | null> {
    const page = Object.hasOwn(PAGES, pathname) ? PAGES[pathname]! : null
    if (!page) return null
    const view: AccountView = page === 'account' && !user ? 'sign-in' : page
    const token =
      view === 'reset' || view === 'confirm-email' ? (first(searchParams.token) ?? '') : ''
    const info =
      view === 'reset'
        ? await accounts.tokenInfo(token, 'password')
        : view === 'confirm-email'
          ? await accounts.tokenInfo(token, 'email')
          : null
    const flash = options.readFlash(searchParams.flash)
    const action = (name: string) => options.actionUrl(`account-${name}`)
    return {
      props: {
        view,
        user,
        verified: view === 'account' && user ? await accounts.isVerified(user.id) : false,
        canUseAdmin: user ? options.canUseAdmin(user) : false,
        fields:
          view === 'account' && user
            ? options.users.fields(user.role).filter((meta) => meta.definition.onAccount)
            : [],
        meta: view === 'account' && user ? await options.users.getMeta(user.id) : {},
        canRegister: accounts.canRegister(),
        token: token || null,
        valid: info !== null,
        newEmail: info?.newEmail ?? null,
        notice: flash ? { kind: flash.kind, message: flash.message } : null,
        next: safeRedirectPath(first(searchParams.next)),
        actions: {
          signIn: action('sign-in'),
          register: action('register'),
          lostPassword: action('lost-password'),
          reset: action('reset'),
          name: action('name'),
          password: action('password'),
          email: action('email'),
          confirmEmail: action('confirm-email'),
          signOut: action('sign-out'),
        },
        paths: { account: ACCOUNT_PATH, lostPassword: `${ACCOUNT_PATH}/lost-password` },
      },
      // A token in the address mustn't reach another site in a Referer header. Not
      // `no-referrer`: with it, browsers post the page's forms with `Origin: null`, which the
      // actions refuse as cross-site.
      metadata: {
        title: TITLES[view],
        noindex: true,
        referrer: token ? 'same-origin' : null,
      },
    }
  }
}
