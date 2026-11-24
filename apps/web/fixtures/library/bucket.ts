import { randomUUID } from 'node:crypto'
import { HttpError, type ApiRoute, type MediaStorage } from '@otwdesign/sdk'

// The e2e tests' storage plugin, in memory: what a real one (S3, say) does, without a service to
// run. Browsers send large files straight to it, at a signed address on this site's own API,
// which stands in for the bucket's.

interface Kept {
  data: Uint8Array
  at: Date
}

interface Shelf {
  files: Map<string, Kept>
  /** The signed addresses given out: each takes one file of one size at one key. */
  signed: Map<string, { key: string; size: number }>
}

// Outside the kernel, which is rebuilt when a setting changes: the bucket's files stay.
const shelf: Shelf = ((globalThis as { libraryBucket?: Shelf }).libraryBucket ??= {
  files: new Map(),
  signed: new Map(),
})

/** Files this small go through the site, so a test can send one each way. */
export const DIRECT_FROM_BYTES = 1024

/** The storage, and the route its signed addresses lead to. `origin` is the site's own. */
export function testBucket(
  origin: string,
  putUrl: string,
): { storage: MediaStorage; put: ApiRoute } {
  const storage: MediaStorage = {
    async create(key, data) {
      if (shelf.files.has(key)) return false
      shelf.files.set(key, { data: new Uint8Array(data), at: new Date() })
      return true
    },
    async read(key, range) {
      const file = shelf.files.get(key)
      if (!file) return null
      const part = range ? file.data.subarray(range.start, range.end + 1) : file.data
      return {
        body: new Blob([new Uint8Array(part)]).stream(),
        size: file.data.byteLength,
        modifiedAt: file.at,
      }
    },
    async stat(key) {
      const file = shelf.files.get(key)
      return file ? { size: file.data.byteLength, modifiedAt: file.at } : null
    },
    async delete(key) {
      shelf.files.delete(key)
    },
    url: (key) => `/uploads/${key}`,
    directUploads: {
      minBytes: DIRECT_FROM_BYTES,
      async target(key, { size }) {
        const signature = randomUUID()
        shelf.signed.set(signature, { key, size })
        return {
          url: `${origin}${putUrl}?signature=${signature}`,
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream' },
        }
      },
    },
  }

  const put: ApiRoute = {
    method: 'PUT',
    path: '/bucket',
    // No session: as with a real bucket, the signature is what lets the bytes in.
    async handler(request) {
      const signature = new URL(request.url).searchParams.get('signature') ?? ''
      const expected = shelf.signed.get(signature)
      if (!expected) throw new HttpError(403, 'SignatureDoesNotMatch')
      const data = new Uint8Array(await request.arrayBuffer())
      if (data.byteLength !== expected.size) throw new HttpError(400, 'Wrong length')
      shelf.signed.delete(signature)
      shelf.files.set(expected.key, { data, at: new Date() })
      return new Response(null, { status: 200 })
    },
  }
  return { storage, put }
}
