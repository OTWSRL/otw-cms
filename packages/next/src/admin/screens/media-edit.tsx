import { Button, EditColumns, Postbox } from '@otw/admin-ui'
import { formatBytes, type Kernel } from '@otw/core'
import type { MediaItem, SearchParams, User } from '@otw/sdk'
import type { ReactNode } from 'react'
import { AdminScreen } from '../screen'
import { formatDate } from './content-dates'
import { CopyButton } from './copy-button'
import { MediaThumbnail } from './media-thumbnail'

/** What the screen shows of the file itself: the image, a player, or its type and a link. */
function Preview({ item }: { item: MediaItem }) {
  if (item.kind === 'image') {
    // The large size, or the image itself when it's no bigger: the file is at most 2560 wide.
    const size = item.sizes.large
    const source = size ?? { url: item.url, width: item.width ?? 0, height: item.height ?? 0 }
    return (
      // The library's own large size, already made; an optimizer would only resize it again.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        className="media-preview"
        src={source.url}
        width={source.width || undefined}
        height={source.height || undefined}
        alt={item.alt}
      />
    )
  }
  if (item.kind === 'video') {
    return <video className="media-preview" src={item.url} controls preload="metadata" />
  }
  if (item.kind === 'audio') {
    return <audio className="media-preview" src={item.url} controls preload="metadata" />
  }
  return (
    <p className="media-preview-file">
      <MediaThumbnail item={item} large /> <a href={item.url}>{item.filename}</a>
    </p>
  )
}

/** One line of the Save box's details: "File type: image/jpeg". */
function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="misc-pub-section">
      {label}: <strong>{children}</strong>
    </div>
  )
}

/** The attachment edit screen (post.php for a file): its details, its fields, Update, Delete. */
export async function MediaEditScreen({
  kernel,
  user,
  item,
  searchParams,
}: {
  kernel: Kernel
  user: User
  item: MediaItem
  searchParams: SearchParams
}) {
  const [[uploader], entry] = await Promise.all([
    item.authorId ? kernel.auth.getUsers([item.authorId]) : Promise.resolve([]),
    item.entryId ? kernel.content.get(item.entryId) : Promise.resolve(null),
  ])
  const entryType = entry ? kernel.content.getType(entry.type) : undefined
  const locale = kernel.setting('site.locale')
  const absoluteUrl = item.url
  const isImage = item.kind === 'image'

  const main = (
    <>
      <div className="titlediv">
        <label className="screen-reader-text" htmlFor="title">
          Add title
        </label>
        <input
          type="text"
          id="title"
          name="title"
          className="entry-title"
          defaultValue={item.title}
          placeholder="Add title"
          maxLength={200}
          autoComplete="off"
        />
      </div>
      <div className="media-preview-wrap">
        <Preview item={item} />
      </div>
      {isImage && (
        <p className="media-field">
          <label htmlFor="alt">Alternative Text</label>
          <input type="text" id="alt" name="alt" defaultValue={item.alt} maxLength={500} />
          <span className="description">
            Describe the purpose of the image. Leave it empty if the image is purely decorative.
          </span>
        </p>
      )}
      {!isImage && <input type="hidden" name="alt" value={item.alt} />}
      <p className="media-field">
        <label htmlFor="caption">Caption</label>
        <textarea id="caption" name="caption" rows={3} defaultValue={item.caption} />
      </p>
      <p className="media-field">
        <label htmlFor="description">Description</label>
        <textarea id="description" name="description" rows={5} defaultValue={item.description} />
      </p>
    </>
  )

  const side = (
    <Postbox id="submitdiv" title="Save">
      <div className="submitbox">
        <div className="misc-publishing-actions">
          <Detail label="Uploaded on">
            <time dateTime={item.createdAt.toISOString()}>
              {formatDate(item.createdAt, locale)}
            </time>
          </Detail>
          {uploader && <Detail label="Uploaded by">{uploader.name || uploader.email}</Detail>}
          {entry && (
            <Detail label="Uploaded to">
              {entryType?.adminPath && kernel.can(user, entryType.capabilities.editEntry, entry) ? (
                <a href={`${entryType.adminPath}/${entry.id}`}>{entry.title || '(no title)'}</a>
              ) : (
                entry.title || '(no title)'
              )}
            </Detail>
          )}
          <div className="misc-pub-section">
            <label htmlFor="file-url">File URL:</label>
            <input type="text" id="file-url" className="widefat" readOnly value={absoluteUrl} />
            <CopyButton text={absoluteUrl} label="Copy URL to clipboard" />
          </div>
          <Detail label="File name">{item.file.split('/').pop()}</Detail>
          <Detail label="File type">{item.mimeType}</Detail>
          <Detail label="File size">{formatBytes(item.size)}</Detail>
          {item.width && item.height && (
            <Detail label="Dimensions">
              {item.width} by {item.height} pixels
            </Detail>
          )}
          {item.originalFile && (
            <div className="misc-pub-section">
              Original image:{' '}
              <a href={item.originalUrl ?? item.url}>{item.originalFile.split('/').pop()}</a>
            </div>
          )}
        </div>
        <div className="major-publishing-actions">
          <div className="publishing-action">
            <Button type="submit" variant="primary">
              Update
            </Button>
          </div>
          {kernel.can(user, 'core.delete_media', item) && (
            <div className="delete-action">
              <button
                type="submit"
                formAction={kernel.actionUrl('core', 'delete-media')}
                className="button-link button-link-delete submitdelete"
              >
                Delete permanently
              </button>
            </div>
          )}
        </div>
      </div>
    </Postbox>
  )

  return (
    <AdminScreen
      title="Edit Media"
      titleAction={{ label: 'Add New Media File', url: '/admin/media/new' }}
      flash={kernel.readFlash(searchParams.flash)}
    >
      <form method="post" action={kernel.actionUrl('core', 'save-media')} className="entry-form">
        <input type="hidden" name="id" value={item.id} />
        <EditColumns main={main} side={side} />
      </form>
    </AdminScreen>
  )
}
