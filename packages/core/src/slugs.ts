/** WordPress's limit for `post_name`. */
export const MAX_SLUG_LENGTH = 200

/**
 * An address-friendly form of `text`, like WordPress's `sanitize_title()`: lowercase, accents
 * taken off Latin letters, and anything but letters, marks and digits turned into single dashes.
 * Other scripts keep their letters and marks, so `Привет мир` gives `привет-мир`.
 */
export function slugify(text: string): string {
  const unaccented = text
    .normalize('NFKD')
    .replace(/(\p{Script=Latin})\p{M}+/gu, '$1')
    .normalize('NFC')
  const slug = unaccented
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-')
  return truncate(slug.replace(/^-+/, ''), MAX_SLUG_LENGTH)
}

/** `slug` if no one has it, otherwise the first of `slug-2`, `slug-3`… that's free, as WordPress does. */
export function firstFreeSlug(slug: string, taken: ReadonlySet<string>): string {
  if (!taken.has(slug)) return slug
  for (let n = 2; ; n++) {
    const suffix = `-${n}`
    const candidate = truncate(slug, MAX_SLUG_LENGTH - suffix.length) + suffix
    if (!taken.has(candidate)) return candidate
  }
}

/** The start of every slug `firstFreeSlug()` can make from `slug`, for finding the ones taken. */
export function slugStem(slug: string): string {
  // Suffixes stay shorter than 11 characters: -9999999999 would take ten billion clashes.
  return truncate(slug, MAX_SLUG_LENGTH - 11)
}

/** At most `length` characters (code points, so no letter is cut in half), without a trailing dash. */
function truncate(slug: string, length: number): string {
  return Array.from(slug).slice(0, length).join('').replace(/-+$/, '')
}
