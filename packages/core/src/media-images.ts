import type { ImageSize } from '@otwdesign/sdk'
import type { Metadata, Sharp } from 'sharp'

/**
 * sharp, loaded with the first image rather than when the server starts: libvips takes about
 * 27 MB that a site taking no uploads never needs.
 */
const loadSharp = () => import('sharp').then((module) => module.default)

/** Above this, an image is scaled down for the site, keeping the original: `big_image_size_threshold`. */
export const BIG_IMAGE_THRESHOLD = 2560

/** WordPress's default quality for its image editors (`wp_editor_set_quality`). */
const QUALITY = { jpeg: 82, webp: 86 }

/** How each type the CMS makes sizes of is written, in its own format, as WordPress keeps it. */
const ENCODERS: Readonly<Record<string, (image: Sharp) => Sharp>> = {
  'image/jpeg': (image) => image.jpeg({ quality: QUALITY.jpeg }),
  'image/png': (image) => image.png(),
  'image/gif': (image) => image.gif(),
  'image/webp': (image) => image.webp({ quality: QUALITY.webp }),
  'image/avif': (image) => image.avif(),
}

/** An image's real type and its size as shown, EXIF orientation applied. */
export interface ImageInfo {
  mimeType: string
  width: number
  height: number
}

/** Decodes an image's header: its real type and dimensions, or `null` if it isn't one. */
export async function readImage(data: Uint8Array): Promise<ImageInfo | null> {
  // Outside the try: sharp failing to load is an error, not a file that isn't an image.
  const sharp = await loadSharp()
  let metadata: Metadata
  try {
    metadata = await sharp(data).metadata()
  } catch {
    return null
  }
  const { format, width, height, orientation, compression } = metadata
  const mimeType =
    format === 'heif'
      ? compression === 'av1'
        ? 'image/avif'
        : null
      : format === 'jpeg' || format === 'png' || format === 'gif' || format === 'webp'
        ? `image/${format}`
        : null
  if (!mimeType || !width || !height) return null
  // Orientations 5 to 8 turn the image a quarter, so it shows as tall as it's stored wide.
  const turned = orientation !== undefined && orientation >= 5
  return { mimeType, width: turned ? height : width, height: turned ? width : height }
}

/**
 * The size an image becomes within `maxWidth` × `maxHeight`, keeping its shape, like
 * `wp_constrain_dimensions()`. 0 leaves a side free.
 */
export function constrain(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number } {
  const ratio = Math.min(
    maxWidth > 0 ? maxWidth / width : Infinity,
    maxHeight > 0 ? maxHeight / height : Infinity,
    1,
  )
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  }
}

/**
 * What a size makes of an image, like `image_resize_dimensions()`: cropped to the size from the
 * center, as far as the image reaches, or fitted within it. `null` when the image is no bigger.
 */
export function sizeDimensions(
  width: number,
  height: number,
  size: Pick<ImageSize, 'width' | 'height' | 'crop'>,
): { width: number; height: number } | null {
  let target: { width: number; height: number }
  if (size.crop) {
    const aspect = width / height
    let w = Math.min(size.width, width)
    let h = Math.min(size.height, height)
    if (!w) w = Math.round(h * aspect)
    if (!h) h = Math.round(w / aspect)
    target = { width: Math.max(1, w), height: Math.max(1, h) }
  } else {
    target = constrain(width, height, size.width, size.height)
  }
  return target.width >= width && target.height >= height ? null : target
}

/** A size's file: the sizes that share its dimensions, and its bytes. */
export interface ResizedImage {
  names: string[]
  width: number
  height: number
  data: Uint8Array
}

export interface ProcessedImage {
  /** The image served as the file, when the original was above the threshold. */
  scaled: { width: number; height: number; data: Uint8Array } | null
  /** The served file's dimensions: the scaled image's, or the original's. */
  width: number
  height: number
  /** One per distinct dimensions: sizes that come out the same share a file, as in WordPress. */
  sizes: ResizedImage[]
}

async function encode(
  source: Uint8Array,
  mimeType: string,
  width: number,
  height: number,
  crop: boolean,
): Promise<Uint8Array> {
  const sharp = await loadSharp()
  // Turned upright and without the original's metadata (camera, location), as WordPress's sizes.
  const resized = sharp(source)
    .rotate()
    .resize(width, height, { fit: crop ? 'cover' : 'fill', position: 'centre' })
  const output = await ENCODERS[mimeType]!(resized).toBuffer()
  return new Uint8Array(output.buffer, output.byteOffset, output.byteLength)
}

/**
 * Makes an image's files, like `wp_create_image_subsizes()`: scaled down to the threshold when
 * it's above it, then each size from that, never enlarged. The original is kept as it is.
 */
export async function processImage(
  data: Uint8Array,
  info: ImageInfo,
  sizes: readonly ImageSize[],
): Promise<ProcessedImage> {
  const big = info.width > BIG_IMAGE_THRESHOLD || info.height > BIG_IMAGE_THRESHOLD
  let scaled: ProcessedImage['scaled'] = null
  if (big) {
    const target = constrain(info.width, info.height, BIG_IMAGE_THRESHOLD, BIG_IMAGE_THRESHOLD)
    scaled = {
      ...target,
      data: await encode(data, info.mimeType, target.width, target.height, false),
    }
  }
  const base = scaled ?? { width: info.width, height: info.height, data }
  const byDimensions = new Map<
    string,
    { names: string[]; width: number; height: number; crop: boolean }
  >()
  for (const size of sizes) {
    const target = sizeDimensions(base.width, base.height, size)
    if (!target) continue
    const key = `${target.width}x${target.height}`
    const existing = byDimensions.get(key)
    if (existing) existing.names.push(size.name)
    else byDimensions.set(key, { names: [size.name], ...target, crop: size.crop })
  }
  const resized = await Promise.all(
    [...byDimensions.values()].map(async ({ names, width, height, crop }) => ({
      names,
      width,
      height,
      data: await encode(base.data, info.mimeType, width, height, crop),
    })),
  )
  return { scaled, width: base.width, height: base.height, sizes: resized }
}
