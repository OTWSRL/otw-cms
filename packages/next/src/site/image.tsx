import type { MediaItem } from '@otwdesign/sdk'

/** WordPress's `max_srcset_image_width`: wider sizes are left out of `srcset`. */
const MAX_SRCSET_WIDTH = 2048

/** A file the browser may choose: its address and width. */
interface Source {
  url: string
  width: number
  height: number
}

/** The size asked for, or the image itself when it has no such size (it's smaller). */
function chosen(item: MediaItem, size: string): Source {
  const named = size === 'full' ? undefined : item.sizes[size]
  return named ?? { url: item.url, width: item.width ?? 0, height: item.height ?? 0 }
}

/**
 * The files of the same shape as `source`, for `srcset`, as `wp_calculate_image_srcset()` picks
 * them: a cropped thumbnail isn't a smaller copy of a landscape photo. Each width once, up to
 * 2048, from narrowest.
 */
export function srcSetOf(item: MediaItem, source: Source): string | undefined {
  if (!source.width || !source.height) return undefined
  const ratio = source.width / source.height
  const files = [
    ...Object.values(item.sizes),
    { url: item.url, width: item.width ?? 0, height: item.height ?? 0 },
  ]
  const byWidth = new Map<number, string>()
  for (const file of files) {
    const sameShape = file.height > 0 && Math.abs(Math.round(file.width / ratio) - file.height) <= 1
    const allowed = file.width <= MAX_SRCSET_WIDTH || file.url === source.url
    if (sameShape && allowed && !byWidth.has(file.width)) byWidth.set(file.width, file.url)
  }
  if (byWidth.size < 2) return undefined
  return [...byWidth]
    .sort(([a], [b]) => a - b)
    .map(([width, url]) => `${encodeURI(url)} ${width}w`)
    .join(', ')
}

/**
 * An image from the media library, as `wp_get_attachment_image()` writes it: the size asked
 * for, with its dimensions, so the page doesn't jump as it loads, and every same-shaped size in
 * `srcset`, so phones download a smaller file. Lazy unless it's `priority`, as a page's first
 * image should be. A server component: no JavaScript.
 */
export function Image({
  item,
  size = 'large',
  alt,
  sizes,
  className,
  priority = false,
}: {
  item: MediaItem
  /** `thumbnail`, `medium`, `large`, a plugin's, or `full` for the image itself. */
  size?: string
  /** Defaults to the file's alternative text. */
  alt?: string
  /** How wide it shows; defaults to its width, or the screen's when that's narrower. */
  sizes?: string
  className?: string
  /** Loads at once, for the image a visitor sees first. */
  priority?: boolean
}) {
  const source = chosen(item, size)
  const srcSet = srcSetOf(item, source)
  return (
    // A file the library already sized; next/image's optimizer would resize it again.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={source.url}
      width={source.width || undefined}
      height={source.height || undefined}
      srcSet={srcSet}
      sizes={
        srcSet ? (sizes ?? `(max-width: ${source.width}px) 100vw, ${source.width}px`) : undefined
      }
      alt={alt ?? item.alt}
      className={className}
      loading={priority ? 'eager' : 'lazy'}
      decoding="async"
      {...(priority ? { fetchPriority: 'high' as const } : {})}
    />
  )
}
