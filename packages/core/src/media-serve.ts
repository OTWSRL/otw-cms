import type { MediaStorage } from '@otwdesign/sdk'
import { isSafeKey } from './media-files'
import { ALLOWED_MIMES, mimeForExtension } from './media-types'

/**
 * A day: long enough for pages to load fast, short enough that a file deleted and uploaded again
 * under the same name shows within one. Revalidation is cheap, by ETag.
 */
const CACHE_CONTROL = 'public, max-age=86400'

/** What a browser may show inline; anything else downloads. */
const INLINE = /^(image|audio|video|text)\/|^application\/pdf$/

/**
 * Nothing in an upload may run: a file that a browser could take for a page gets no scripts,
 * forms or same-origin access. PDF viewers don't work in a sandbox, and PDFs can't script the
 * site anyway.
 */
const SANDBOX = "default-src 'none'; style-src 'unsafe-inline'; sandbox"

function notFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

/** One range from a `Range` header, as RFC 9110 has it; `null` to send the whole file. */
export function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  // Several ranges, or other units: sending the whole file is always allowed.
  if (!match || (match[1] === '' && match[2] === '')) return null
  if (size === 0) return 'unsatisfiable'
  if (match[1] === '') {
    const suffix = Number(match[2])
    if (suffix === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(match[1])
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1)
  if (start >= size || end < start) return 'unsatisfiable'
  return { start, end }
}

/**
 * Serves an upload from storage, as a web server serves `wp-content/uploads`: with its type, an
 * ETag and Last-Modified for revalidation, and byte ranges, which video players need.
 */
export async function serveUpload(
  storage: MediaStorage,
  key: string,
  request: Request,
): Promise<Response> {
  if (!isSafeKey(key)) return notFound()
  const info = await storage.stat(key)
  if (!info) return notFound()

  const extension = key.slice(key.lastIndexOf('.') + 1)
  const type = mimeForExtension(ALLOWED_MIMES, extension) ?? 'application/octet-stream'
  const etag = `"${info.size.toString(36)}-${info.modifiedAt.getTime().toString(36)}"`
  const headers = new Headers({
    'Content-Type': type.startsWith('text/') ? `${type}; charset=utf-8` : type,
    'Cache-Control': CACHE_CONTROL,
    ETag: etag,
    'Last-Modified': info.modifiedAt.toUTCString(),
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': INLINE.test(type) ? 'inline' : 'attachment',
  })
  if (type !== 'application/pdf') headers.set('Content-Security-Policy', SANDBOX)

  const ifNoneMatch = request.headers.get('if-none-match')
  const ifModifiedSince = request.headers.get('if-modified-since')
  const unchanged = ifNoneMatch
    ? ifNoneMatch.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag)
    : ifModifiedSince !== null &&
      Math.floor(info.modifiedAt.getTime() / 1000) <= Date.parse(ifModifiedSince) / 1000
  if (unchanged) return new Response(null, { status: 304, headers })

  // If-Range: a range of a file that changed since would mix two versions, so send it whole.
  const ifRange = request.headers.get('if-range')
  const range =
    ifRange && ifRange !== etag ? null : parseRange(request.headers.get('range'), info.size)
  if (range === 'unsatisfiable') {
    headers.set('Content-Range', `bytes */${info.size}`)
    return new Response(null, { status: 416, headers })
  }
  const length = range ? range.end - range.start + 1 : info.size
  headers.set('Content-Length', String(length))
  if (range) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${info.size}`)
  const status = range ? 206 : 200
  if (request.method === 'HEAD') return new Response(null, { status, headers })

  const file = await storage.read(key, range ?? undefined)
  if (!file) return notFound()
  return new Response(file.body, { status, headers })
}
