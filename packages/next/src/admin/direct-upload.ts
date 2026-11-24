/**
 * Uploads sent straight to storage, for sites whose host caps a request's size. Loaded only
 * where the storage takes them, and only when a file is large enough to go that way.
 */

/** What the server renders into an uploader when the storage takes files from the browser. */
export interface DirectUploads {
  /** Files of this many bytes or more go straight to storage. */
  minBytes: number
}

export type Sent<T> = { ok: true; item: T } | { ok: false; error: string }

interface Begun {
  id: string
  url: string
  headers: Record<string, string>
}

const LOST = 'The upload failed: the connection was lost.'
/** How often the site is asked to store the file, when it's busy or the answer is lost. */
const COMPLETE_TRIES = 6
const RETRY_MS = 2000
/** Headers a browser sets itself, and refuses from a page. */
const BROWSER_SET = new Set(['content-length', 'host'])

async function errorOf(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null
  return body?.error ?? `The upload failed (${response.status}).`
}

/** Sends the bytes to the signed address; resolves with what went wrong, or `null`. */
function put(target: Begun, file: File, onProgress: (percent: number) => void) {
  return new Promise<string | null>((resolve) => {
    // XMLHttpRequest, not fetch: only it reports how much of the upload has been sent.
    const request = new XMLHttpRequest()
    request.open('PUT', target.url)
    for (const [name, value] of Object.entries(target.headers)) {
      if (!BROWSER_SET.has(name.toLowerCase())) request.setRequestHeader(name, value)
    }
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100))
    }
    request.onload = () =>
      resolve(
        request.status >= 200 && request.status < 300
          ? null
          : `The storage refused the file (${request.status}).`,
      )
    // A refused cross-origin request and a lost connection look the same from here.
    request.onerror = () =>
      resolve(
        'The file couldn’t be sent to storage. If every file fails, the storage doesn’t accept uploads from this site: an administrator should check its CORS rules.',
      )
    request.send(file)
  })
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Has the site store what was sent. Asking twice is safe: it answers the same item. */
async function complete<T>(api: string, id: string): Promise<Sent<T>> {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(`${api}/uploads/${id}/complete`, { method: 'POST' }).catch(
      () => null,
    )
    if (response?.status === 201 || response?.status === 200) {
      return { ok: true, item: (await response.json()) as T }
    }
    // Being stored by an earlier try whose answer was lost, or the connection dropped again.
    const passing = response === null || response.status === 409
    if (!passing) return { ok: false, error: await errorOf(response) }
    if (attempt === COMPLETE_TRIES) {
      return { ok: false, error: response ? await errorOf(response) : LOST }
    }
    await wait(RETRY_MS)
  }
}

/**
 * Uploads one file past the site: asks it for a signed address, sends the bytes there with their
 * progress, then has the site check and store the file. Resolves with the item, as the upload
 * API answers it, or an error people can read.
 */
export async function sendDirect<T>(
  api: string,
  file: File,
  entryId: string | undefined,
  onProgress: (percent: number) => void,
): Promise<Sent<T>> {
  const begin = await fetch(`${api}/uploads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: file.name,
      size: file.size,
      ...(entryId ? { entry: entryId } : {}),
    }),
  }).catch(() => null)
  if (!begin) return { ok: false, error: LOST }
  if (begin.status !== 201) return { ok: false, error: await errorOf(begin) }
  const target = (await begin.json()) as Begun

  const problem = await put(target, file, onProgress)
  if (problem !== null) {
    // Whatever part arrived is of no use: the site deletes it now rather than when it runs out.
    void fetch(`${api}/uploads/${target.id}`, { method: 'DELETE', keepalive: true }).catch(() => {})
    return { ok: false, error: problem }
  }
  return complete<T>(api, target.id)
}
