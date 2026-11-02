'use client'

import { useRef, useState, useSyncExternalStore, type DragEvent } from 'react'

const noSubscription = () => () => {}

/** One file's upload, as the list under the drop zone shows it. */
type Upload =
  | { key: number; name: string; state: 'uploading'; percent: number }
  | { key: number; name: string; state: 'failed'; error: string }
  | {
      key: number
      name: string
      state: 'done'
      item: { id: string; title: string; kind: string; sizes: { thumbnail?: { url: string } } }
    }

/** Sends one file to the upload API, reporting its progress; resolves with the item or an error. */
function send(
  api: string,
  file: File,
  onProgress: (percent: number) => void,
): Promise<
  { ok: true; item: Extract<Upload, { state: 'done' }>['item'] } | { ok: false; error: string }
> {
  return new Promise((resolve) => {
    const form = new FormData()
    form.append('file', file)
    // XMLHttpRequest, not fetch: only it reports how much of the upload has been sent.
    const request = new XMLHttpRequest()
    request.open('POST', api)
    request.responseType = 'json'
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100))
    }
    request.onload = () => {
      const body = request.response as { error?: string; id?: string } | null
      if (request.status === 201 && body?.id) {
        resolve({ ok: true, item: body as Extract<Upload, { state: 'done' }>['item'] })
      } else {
        resolve({ ok: false, error: body?.error ?? `The upload failed (${request.status}).` })
      }
    }
    request.onerror = () =>
      resolve({ ok: false, error: 'The upload failed: the connection was lost.' })
    request.send(form)
  })
}

/**
 * media-new.php's uploader: drop files or choose them, and each uploads at once with its
 * progress, one after another, as WordPress's plupload does. Before JavaScript loads (or
 * without it), it's a plain form that posts the chosen files: WordPress's browser uploader.
 */
export function MediaUploader({
  action,
  api,
  maxBytes,
  limit,
}: {
  /** The form's admin action, for uploads without JavaScript. */
  action: string
  /** The upload API, one file per request. */
  api: string
  maxBytes: number
  /** The limit as people read it: "64 MB". */
  limit: string
}) {
  const [uploads, setUploads] = useState<Upload[]>([])
  const [dragging, setDragging] = useState(false)
  // False on the server and while hydrating, so both render the plain form; true after.
  const enhanced = useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  )
  const queue = useRef(Promise.resolve())
  const next = useRef(0)

  const change = (key: number, upload: Upload) =>
    setUploads((current) => current.map((item) => (item.key === key ? upload : item)))

  const start = (files: Iterable<File>) => {
    for (const file of files) {
      const key = next.current++
      if (file.size > maxBytes) {
        setUploads((current) => [
          ...current,
          {
            key,
            name: file.name,
            state: 'failed',
            error: `The file is larger than the ${limit} limit.`,
          },
        ])
        continue
      }
      setUploads((current) => [
        ...current,
        { key, name: file.name, state: 'uploading', percent: 0 },
      ])
      queue.current = queue.current.then(async () => {
        const result = await send(api, file, (percent) =>
          change(key, { key, name: file.name, state: 'uploading', percent }),
        )
        change(
          key,
          result.ok
            ? { key, name: file.name, state: 'done', item: result.item }
            : { key, name: file.name, state: 'failed', error: result.error },
        )
      })
    }
  }

  const drop = (event: DragEvent) => {
    event.preventDefault()
    setDragging(false)
    start(event.dataTransfer.files)
  }

  return (
    <>
      <form
        method="post"
        action={action}
        encType="multipart/form-data"
        className="media-uploader"
        onSubmit={(event) => {
          event.preventDefault()
          const input = event.currentTarget.elements.namedItem('files') as HTMLInputElement
          start(input.files ?? [])
          input.value = ''
        }}
      >
        <div
          className={dragging ? 'drag-drop-area drag-over' : 'drag-drop-area'}
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={drop}
        >
          {enhanced && (
            <>
              <p className="drag-drop-info">Drop files to upload</p>
              <p>or</p>
            </>
          )}
          <input
            type="file"
            id="media-files"
            name="files"
            multiple
            className={enhanced ? 'screen-reader-text' : undefined}
            onChange={(event) => {
              if (!enhanced) return
              start(event.target.files ?? [])
              event.target.value = ''
            }}
          />
          {enhanced ? (
            <label htmlFor="media-files" className="button button-hero">
              Select Files
            </label>
          ) : (
            <button type="submit" className="button button-primary">
              Upload
            </button>
          )}
        </div>
      </form>
      {uploads.length > 0 && (
        <ul className="media-items" aria-label="Uploads" aria-live="polite">
          {uploads.map((upload) => (
            <li key={upload.key} className={`media-item media-item-${upload.state}`}>
              {upload.state === 'done' && upload.item.sizes.thumbnail && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={upload.item.sizes.thumbnail.url} alt="" width={40} height={40} />
              )}
              <span className="media-item-name">
                {upload.state === 'done' ? upload.item.title || upload.name : upload.name}
              </span>
              {upload.state === 'uploading' && (
                <progress max={100} value={upload.percent} aria-label={`Uploading ${upload.name}`}>
                  {upload.percent}%
                </progress>
              )}
              {upload.state === 'failed' && (
                <span className="media-item-error" role="alert">
                  “{upload.name}” wasn&apos;t uploaded: {upload.error}
                </span>
              )}
              {upload.state === 'done' && (
                <a href={`/admin/media/${upload.item.id}`} className="edit-attachment">
                  Edit
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
