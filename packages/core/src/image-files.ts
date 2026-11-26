import { createHash } from 'node:crypto'

/**
 * A small image a plugin gives as a data: address, such as its menu icon or a sign-in button's
 * mark, served from an address of its own. A page then carries the address rather than the image
 * (twice: in the HTML and in React's data), and the browser fetches it once and keeps it.
 */
export interface ImageFile {
  type: 'image/svg+xml' | 'image/png'
  bytes: Uint8Array
  /** Changes with the image, so an address that names it can be kept for good. */
  version: string
}

const DATA_ADDRESS = /^data:(image\/svg\+xml|image\/png);base64,([A-Za-z0-9+/]+={0,2})$/

/** The image a base64 data: address holds, or null for anything else. */
export function imageFile(address: string): ImageFile | null {
  const match = DATA_ADDRESS.exec(address)
  if (!match) return null
  return {
    type: match[1] as ImageFile['type'],
    bytes: Buffer.from(match[2]!, 'base64'),
    version: createHash('sha256').update(address).digest('hex').slice(0, 12),
  }
}

/** `path?v=version`: the address a page puts the image at. */
export function imageAddress(path: string, file: ImageFile): string {
  return `${path}?v=${file.version}`
}

const YEAR = 31_536_000

/**
 * The image, kept a year when the address names this version of it, or checked again each time
 * when it names another: a page from before the image changed still draws it. `private` for
 * images only signed-in people may fetch.
 */
export function imageResponse(
  request: Request,
  file: ImageFile,
  cache: 'public' | 'private',
): Response {
  const current = new URL(request.url).searchParams.get('v') === file.version
  return new Response(file.bytes as Uint8Array<ArrayBuffer>, {
    headers: {
      'content-type': file.type,
      'cache-control': current ? `${cache}, max-age=${YEAR}, immutable` : `${cache}, no-cache`,
      'x-content-type-options': 'nosniff',
      // Opened on its own, an SVG is a document of this site: it's saved rather than shown, and
      // nothing in it may run or load. An <img> or a CSS mask draws it all the same.
      'content-disposition': 'attachment',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  })
}
