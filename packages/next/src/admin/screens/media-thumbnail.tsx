import type { MediaItem } from '@otw/sdk'

/**
 * An item's picture in the library: an image's thumbnail (or medium size, for the grid), as small
 * a file as will do; other files show their extension, as WordPress shows a type icon.
 */
export function MediaThumbnail({ item, large = false }: { item: MediaItem; large?: boolean }) {
  if (item.kind !== 'image') {
    const extension = item.file.slice(item.file.lastIndexOf('.') + 1).toUpperCase()
    return (
      <span className={large ? 'media-icon media-icon-large' : 'media-icon'} aria-hidden="true">
        {extension}
      </span>
    )
  }
  const size = (large ? item.sizes.medium : undefined) ?? item.sizes.thumbnail
  const source = size ?? { url: item.url, width: item.width ?? 0, height: item.height ?? 0 }
  return (
    // The admin shows the library's own sizes; next/image's optimizer would only resize them again.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={large ? 'media-thumbnail media-thumbnail-large' : 'media-thumbnail'}
      src={source.url}
      width={source.width || undefined}
      height={source.height || undefined}
      alt=""
      loading="lazy"
      decoding="async"
    />
  )
}
