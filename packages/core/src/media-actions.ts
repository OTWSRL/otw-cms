import type { ApiRoute, CapabilityName, MediaKind, MetaCapabilityName, User } from '@otw/sdk'
import { ActionError, ForbiddenError, HttpError, MediaError } from '@otw/sdk'
import type { InternalAction } from './admin'
import { formatBytes, type MediaService } from './media'

export interface MediaActionDependencies {
  media: MediaService
  can(user: User, capability: CapabilityName | MetaCapabilityName, ...args: unknown[]): boolean
  transaction<T>(fn: () => Promise<T>): Promise<T>
  maxBytes: number
}

/** Room in a form for its other fields and the multipart boundaries, beside the files. */
const FORM_OVERHEAD = 64 * 1024
const MAX_BULK = 100

/** WordPress's Media Library and Edit Media links. */
export const MEDIA_PATH = '/admin/media'

function field(form: FormData, name: string): string {
  const value = form.get(name)
  return typeof value === 'string' ? value : ''
}

async function asActionError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof MediaError) throw new ActionError(error.message)
    throw error
  }
}

/** The status each failure gets from the upload API. */
const STATUS: Readonly<Record<MediaError['code'], number>> = {
  invalid_input: 400,
  file_type: 415,
  too_large: 413,
  not_found: 404,
}

/**
 * Media › Add New's form (the browser uploader WordPress falls back to), Edit Media's Update, and
 * Delete Permanently, one file or a page of them.
 */
export function mediaActions(deps: MediaActionDependencies): InternalAction[] {
  const { media, can } = deps
  const limit = formatBytes(deps.maxBytes)

  /** The files, each checked first, so a refusal deletes none of them. */
  const deletable = async (user: User, ids: readonly string[]) => {
    if (ids.length === 0) throw new ActionError('Select the files to delete.')
    if (ids.length > MAX_BULK) throw new ActionError(`Delete at most ${MAX_BULK} files at a time.`)
    const items = await media.getMany(ids)
    if (items.length === 0) throw new ActionError('Those files no longer exist.')
    for (const item of items) {
      if (!can(user, 'core.delete_media', item)) throw new ForbiddenError()
    }
    return items
  }

  return [
    {
      name: 'upload-media',
      capability: 'core.upload_files',
      maxBody: {
        bytes: deps.maxBytes + FORM_OVERHEAD,
        message: `The files are larger than the ${limit} limit together. Upload fewer at a time.`,
      },
      async handler({ form, user }) {
        const files = form
          .getAll('files')
          .filter((value): value is File => value instanceof File && value.size > 0)
        if (files.length === 0) throw new ActionError('Choose the files to upload.')
        const uploaded = []
        const failed: string[] = []
        for (const file of files) {
          try {
            const data = new Uint8Array(await file.arrayBuffer())
            uploaded.push(await media.upload({ name: file.name, data }, { by: user!.id }))
          } catch (error) {
            if (!(error instanceof MediaError)) throw error
            failed.push(`“${file.name}” wasn't uploaded: ${error.message}`)
          }
        }
        if (uploaded.length === 0) throw new ActionError(failed.join(' '))
        const done =
          uploaded.length === 1
            ? `Uploaded “${uploaded[0]!.filename}”.`
            : `Uploaded ${uploaded.length} files.`
        return {
          redirect: uploaded.length === 1 ? `${MEDIA_PATH}/${uploaded[0]!.id}` : MEDIA_PATH,
          notice: [done, ...failed].join(' '),
        }
      },
    },
    {
      name: 'save-media',
      capability: 'core.upload_files',
      async handler({ form, user }) {
        const item = await media.get(field(form, 'id'))
        if (!item) throw new ActionError('That file no longer exists.')
        if (!can(user!, 'core.edit_media', item)) throw new ForbiddenError()
        await asActionError(() =>
          media.update(item.id, {
            title: field(form, 'title'),
            alt: field(form, 'alt'),
            caption: field(form, 'caption'),
            description: field(form, 'description'),
          }),
        )
        return { redirect: `${MEDIA_PATH}/${item.id}`, notice: 'Media file updated.' }
      },
    },
    {
      name: 'delete-media',
      capability: 'core.upload_files',
      async handler({ form, user }) {
        // A row's Delete Permanently names one file; the bulk form, the files checked.
        const single = field(form, 'id')
        if (!single && field(form, 'bulk') !== 'delete') {
          throw new ActionError('Choose a bulk action.')
        }
        const ids = single
          ? [single]
          : form.getAll('ids').filter((value) => typeof value === 'string')
        const items = await deletable(user!, ids)
        await deps.transaction(async () => {
          for (const item of items) await asActionError(() => media.delete(item.id))
        })
        return {
          redirect: MEDIA_PATH,
          notice:
            items.length === 1
              ? 'Media file permanently deleted.'
              : `${items.length} media files permanently deleted.`,
        }
      },
    },
  ]
}

/**
 * `POST /api/p/core/media`: one file from the drag-and-drop uploader (or the editor), as
 * WordPress's `async-upload.php`. Answers with the item, or `{ error }` with a status.
 */
export function mediaUploadRoute(deps: MediaActionDependencies): ApiRoute {
  return {
    method: 'POST',
    path: '/media',
    async handler(request, context) {
      const user = await context.user()
      if (!user) throw new HttpError(401, 'Sign in to upload files.')
      if (!deps.can(user, 'core.access_admin') || !deps.can(user, 'core.upload_files')) {
        throw new ForbiddenError('You are not allowed to upload files.')
      }
      const length = Number(request.headers.get('content-length') ?? NaN)
      if (!Number.isSafeInteger(length)) throw new HttpError(411, 'Send the file with its length.')
      if (length > deps.maxBytes + FORM_OVERHEAD) {
        throw new HttpError(413, `The file is larger than the ${formatBytes(deps.maxBytes)} limit.`)
      }
      let form: FormData
      try {
        form = await request.formData()
      } catch {
        throw new HttpError(400, 'Send the file as a multipart form.')
      }
      const file = form.get('file')
      if (!(file instanceof File)) throw new HttpError(400, 'Send the file in a field named file.')
      const entry = form.get('entry')
      try {
        const item = await deps.media.upload(
          { name: file.name, data: new Uint8Array(await file.arrayBuffer()) },
          { by: user.id, ...(typeof entry === 'string' && entry ? { entryId: entry } : {}) },
        )
        return Response.json(item, { status: 201 })
      } catch (error) {
        if (error instanceof MediaError) throw new HttpError(STATUS[error.code], error.message)
        throw error
      }
    },
  }
}

/** How many files the picker shows at a time. */
const PICKER_PAGE = 40
const KINDS = new Set(['image', 'audio', 'video', 'document', 'spreadsheet', 'archive'])

/**
 * `GET /api/p/core/media`: a page of the library for the media picker, as WordPress's
 * `query-attachments`: `kind`, `search` and `page` (from 1). For those who may upload; others
 * get 403, signed-out people 401.
 */
export function mediaListRoute(deps: MediaActionDependencies): ApiRoute {
  return {
    method: 'GET',
    path: '/media',
    async handler(request, context) {
      const user = await context.user()
      if (!user) throw new HttpError(401, 'Sign in to see the media library.')
      if (!deps.can(user, 'core.access_admin') || !deps.can(user, 'core.upload_files')) {
        throw new ForbiddenError('You are not allowed to see the media library.')
      }
      const query = new URL(request.url).searchParams
      const kind = query.get('kind') ?? ''
      const page = Number(query.get('page') ?? '1')
      if (!Number.isSafeInteger(page) || page < 1)
        throw new HttpError(400, 'Ask for a page from 1.')
      const { items, total } = await deps.media.list({
        ...(KINDS.has(kind) ? { kind: kind as MediaKind } : {}),
        search: (query.get('search') ?? '').slice(0, 200) || undefined,
        limit: PICKER_PAGE,
        offset: (page - 1) * PICKER_PAGE,
      })
      return Response.json(
        { items, total, pages: Math.max(1, Math.ceil(total / PICKER_PAGE)) },
        { headers: { 'Cache-Control': 'no-store' } },
      )
    },
  }
}
