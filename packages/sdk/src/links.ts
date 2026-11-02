/** A scheme is letters, digits, `+`, `-` and `.` before the first colon, as RFC 3986 has it. */
const SCHEME = /^([a-z][a-z0-9+.-]*):/i
const SAFE_SCHEMES = new Set(['http', 'https', 'mailto'])

/**
 * Whether a link in an entry's body may be saved and shown: http(s) and mailto addresses, and
 * paths, queries or fragments on the site. Browsers ignore tabs and line breaks inside a scheme
 * (`java\tscript:`), so any whitespace or control character is refused; spaces are written `%20`.
 */
export function isSafeHref(href: string): boolean {
  if (href === '' || /[\s\p{Cc}]/u.test(href) || href.startsWith('//')) return false
  const scheme = SCHEME.exec(href)?.[1]
  if (scheme !== undefined) return SAFE_SCHEMES.has(scheme.toLowerCase())
  return !href.includes(':') || /^[/?#.]/.test(href)
}
