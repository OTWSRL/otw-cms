'use client'

import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { createPortal } from 'react-dom'

/** What the picker hands back: a file in the library, as the upload and list APIs send it. */
export interface PickedMedia {
  id: string
  url: string
  title: string
  filename: string
  alt: string
  kind: string
  width: number | null
  height: number | null
  sizes: Record<string, { url: string; width: number; height: number }>
}

const API = '/api/p/core/media'

/** The smallest of an image's sizes that shows it well in a tile. */
export function previewOf(item: PickedMedia): string {
  return (item.sizes.medium ?? item.sizes.thumbnail)?.url ?? item.url
}

type Loaded = { items: PickedMedia[]; pages: number } | { error: string } | null

/** Sends one file to the upload API; resolves with the item or an error people can read. */
function upload(
  file: File,
  entryId: string | undefined,
  onProgress: (percent: number) => void,
): Promise<PickedMedia | string> {
  return new Promise((resolve) => {
    const form = new FormData()
    form.append('file', file)
    if (entryId) form.append('entry', entryId)
    const request = new XMLHttpRequest()
    request.open('POST', API)
    request.responseType = 'json'
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100))
    }
    request.onload = () => {
      const body = request.response as (PickedMedia & { error?: string }) | null
      resolve(
        request.status === 201 && body?.id
          ? body
          : (body?.error ?? `The upload failed (${request.status}).`),
      )
    }
    request.onerror = () => resolve('The upload failed: the connection was lost.')
    request.send(form)
  })
}

/**
 * WordPress's media modal, for images: the library to choose from, searchable and paged, and an
 * Upload tab whose file is chosen as soon as it's in. A modal `<dialog>` in a portal to the
 * admin's root, so it's outside the entry's form: Enter in its fields never saves the entry.
 */
export function MediaPicker({
  title,
  action,
  entryId,
  onSelect,
  onClose,
}: {
  title: string
  /** The button that picks the chosen file: "Insert into post", "Set featured image". */
  action: string
  /** The entry uploads are attached to, when it's been saved. */
  entryId?: string
  onSelect(item: PickedMedia): void
  onClose(): void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [tab, setTab] = useState<'library' | 'upload'>('library')
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [loaded, setLoaded] = useState<Loaded>(null)
  const [selected, setSelected] = useState<PickedMedia | null>(null)
  const [uploading, setUploading] = useState<{ name: string; percent: number } | null>(null)
  const [uploadError, setUploadError] = useState('')
  const [justUploaded, setJustUploaded] = useState<PickedMedia[]>([])

  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) element.showModal()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams({ kind: 'image', page: String(page) })
    if (query) params.set('search', query)
    fetch(`${API}?${params}`, { signal: controller.signal })
      .then(async (response) => {
        const body = (await response.json()) as {
          items?: PickedMedia[]
          pages?: number
          error?: string
        }
        setLoaded(
          response.ok && body.items
            ? { items: body.items, pages: body.pages ?? 1 }
            : { error: body.error ?? `The library couldn't be loaded (${response.status}).` },
        )
      })
      .catch((error: unknown) => {
        if ((error as Error).name !== 'AbortError') {
          setLoaded({ error: "The library couldn't be loaded: the connection was lost." })
        }
      })
    return () => controller.abort()
  }, [query, page])

  const send = useCallback(
    async (files: FileList | null) => {
      const file = files?.[0]
      if (!file) return
      setUploadError('')
      setUploading({ name: file.name, percent: 0 })
      const result = await upload(file, entryId, (percent) =>
        setUploading({ name: file.name, percent }),
      )
      setUploading(null)
      if (typeof result === 'string') {
        setUploadError(`“${file.name}” wasn't uploaded: ${result}`)
        return
      }
      if (result.kind !== 'image') {
        setUploadError(`“${file.name}” was uploaded, but it isn't an image.`)
        return
      }
      setJustUploaded((current) => [result, ...current])
      setSelected(result)
      setTab('library')
    },
    [entryId],
  )

  const items = [
    ...justUploaded,
    ...(loaded && 'items' in loaded
      ? loaded.items.filter((item) => !justUploaded.some((uploaded) => uploaded.id === item.id))
      : []),
  ]

  const drop = (event: DragEvent) => {
    event.preventDefault()
    void send(event.dataTransfer.files)
  }

  return createPortal(
    <dialog
      ref={dialog}
      className="media-modal"
      aria-labelledby="media-modal-title"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <div className="media-modal-header">
        <h2 id="media-modal-title">{title}</h2>
        <button type="button" className="media-modal-close" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="media-modal-tabs" role="tablist" aria-label="Choose from">
        {(['upload', 'library'] as const).map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            onClick={() => setTab(name)}
          >
            {name === 'upload' ? 'Upload files' : 'Media Library'}
          </button>
        ))}
      </div>
      <div className="media-modal-body">
        {tab === 'upload' ? (
          <div
            className="drag-drop-area"
            onDragOver={(event) => event.preventDefault()}
            onDrop={drop}
          >
            <p className="drag-drop-info">Drop an image to upload</p>
            <p>or</p>
            <input
              type="file"
              id="media-modal-file"
              accept="image/*"
              className="screen-reader-text"
              onChange={(event) => {
                void send(event.target.files)
                event.target.value = ''
              }}
            />
            <label htmlFor="media-modal-file" className="button button-hero">
              Select Files
            </label>
            {uploading && (
              <p>
                <progress
                  max={100}
                  value={uploading.percent}
                  aria-label={`Uploading ${uploading.name}`}
                />
              </p>
            )}
            {uploadError && (
              <p className="media-item-error" role="alert">
                {uploadError}
              </p>
            )}
          </div>
        ) : (
          <>
            <p className="media-modal-search">
              <label htmlFor="media-modal-search" className="screen-reader-text">
                Search media
              </label>
              <input
                type="search"
                id="media-modal-search"
                placeholder="Search media"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    setPage(1)
                    setQuery(search.trim())
                  }
                }}
              />{' '}
              <button
                type="button"
                className="button"
                onClick={() => {
                  setPage(1)
                  setQuery(search.trim())
                }}
              >
                Search
              </button>
            </p>
            {loaded === null ? (
              <p aria-live="polite">Loading the library…</p>
            ) : 'error' in loaded ? (
              <p className="media-item-error" role="alert">
                {loaded.error}
              </p>
            ) : items.length === 0 ? (
              <p>{query ? 'No images found.' : 'No images yet. Upload one.'}</p>
            ) : (
              <ul className="media-modal-grid" aria-label="Images">
                {items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      aria-pressed={selected?.id === item.id}
                      aria-label={item.title || item.filename}
                      onClick={() => setSelected(item)}
                      onDoubleClick={() => onSelect(item)}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={previewOf(item)} alt="" loading="lazy" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {loaded && 'pages' in loaded && loaded.pages > 1 && (
              <p className="media-modal-pages">
                <button
                  type="button"
                  className="button"
                  disabled={page <= 1}
                  onClick={() => setPage(page - 1)}
                >
                  Newer
                </button>{' '}
                Page {page} of {loaded.pages}{' '}
                <button
                  type="button"
                  className="button"
                  disabled={page >= loaded.pages}
                  onClick={() => setPage(page + 1)}
                >
                  Older
                </button>
              </p>
            )}
          </>
        )}
      </div>
      <div className="media-modal-footer">
        <span className="media-modal-selection">
          {selected
            ? `${selected.title || selected.filename}${selected.width ? `, ${selected.width} × ${selected.height}` : ''}`
            : ''}
        </span>
        <button
          type="button"
          className="button button-primary"
          disabled={!selected}
          onClick={() => selected && onSelect(selected)}
        >
          {action}
        </button>
      </div>
    </dialog>,
    // Inside the admin's root, for its styles, and outside the entry's form.
    document.querySelector('.cms-admin') ?? document.body,
  )
}
