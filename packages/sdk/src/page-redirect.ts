/**
 * Thrown from a page route's `load` to send the visitor elsewhere on the site, like WordPress's
 * `wp_safe_redirect()` in `template_redirect`: an old address to its new one, or a signed-out
 * visitor to sign in (`context.requireUser()` throws one). Only paths on this site, so a page's
 * input can't send people to another site.
 */
export class PageRedirect extends Error {
  readonly location: string

  constructor(location: string) {
    if (
      typeof location !== 'string' ||
      !location.startsWith('/') ||
      location.startsWith('//') ||
      /[\\\s]/.test(location)
    ) {
      throw new TypeError(
        `A page can redirect only to a path on this site, not "${String(location)}"`,
      )
    }
    super(`Redirect to ${location}`)
    this.name = 'PageRedirect'
    this.location = location
  }
}
