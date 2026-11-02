import { FormButton, Notice } from '@otw/admin-ui'
import { diffRevisions, type Kernel } from '@otw/core'
import type { ContentType, Entry, SearchParams } from '@otw/sdk'
import { firstParam } from '../../runtime/search-params'
import { AdminScreen } from '../screen'
import { formatDate } from './content-dates'

/** How many revisions the screen lists: every one a type keeps, by default. */
const SHOWN = 100

/**
 * revision.php: an entry's revisions, newest first, and what one changed from the one before,
 * field by field, with Restore for any but the newest, which is the entry as it is.
 */
export async function ContentRevisionsScreen({
  kernel,
  type,
  entry,
  searchParams,
}: {
  kernel: Kernel
  type: ContentType
  entry: Entry
  searchParams: SearchParams
}) {
  const { revisions } = await kernel.content.revisions(entry.id, { limit: SHOWN })
  const wanted = firstParam(searchParams.revision)
  const index = Math.max(
    0,
    revisions.findIndex((revision) => revision.id === wanted),
  )
  const selected = revisions[index]
  const before = revisions[index + 1] ?? null
  const authorIds = [...new Set(revisions.map((r) => r.authorId).filter((id) => id !== null))]
  const authors = new Map((await kernel.auth.getUsers(authorIds)).map((u) => [u.id, u]))
  const who = (id: string | null) => {
    const author = id ? authors.get(id) : undefined
    return author ? author.name || author.email : 'someone'
  }
  const locale = kernel.setting('site.locale')
  const edit = `${type.adminPath}/${entry.id}`
  const title = entry.title || '(no title)'

  return (
    <AdminScreen
      title={`Compare Revisions of “${title}”`}
      flash={kernel.readFlash(searchParams.flash)}
    >
      <p>
        <a href={edit}>← Go to editor</a>
      </p>
      {!selected ? (
        <Notice type="info">This {type.labels.singular.toLowerCase()} has no revisions yet.</Notice>
      ) : (
        <div className="revisions">
          <nav className="revisions-list" aria-label="Revisions">
            <ol>
              {revisions.map((revision, i) => (
                <li key={revision.id}>
                  <a
                    href={`?revision=${revision.id}`}
                    aria-current={i === index ? 'page' : undefined}
                  >
                    {formatDate(revision.createdAt, locale)}
                  </a>{' '}
                  <span className="description">
                    by {who(revision.authorId)}
                    {i === 0 && ' (current)'}
                  </span>
                </li>
              ))}
            </ol>
          </nav>
          <section className="revisions-diff" aria-labelledby="revision-heading">
            <h2 id="revision-heading">
              {before ? 'Changes' : 'The first revision'} from{' '}
              {formatDate(selected.createdAt, locale)} by {who(selected.authorId)}
            </h2>
            {index > 0 && entry.status !== 'trash' && (
              <FormButton
                action={kernel.actionUrl('core', 'restore-revision')}
                fields={{ id: selected.id }}
                variant="primary"
              >
                Restore This Revision
              </FormButton>
            )}
            {diffRevisions(before, selected).map(({ field, lines }) => (
              <div key={field} className="revision-field">
                <h3>{field}</h3>
                <table className="diff" role="presentation">
                  <tbody>
                    {lines.map((line, i) => (
                      <tr key={i} className={`diff-${line.kind}`}>
                        <td className="diff-marker" aria-hidden="true">
                          {line.kind === 'removed' ? '−' : line.kind === 'added' ? '+' : ''}
                        </td>
                        <td>
                          {line.kind !== 'same' && (
                            <span className="screen-reader-text">
                              {line.kind === 'removed' ? 'Removed: ' : 'Added: '}
                            </span>
                          )}
                          {line.kind === 'removed' ? (
                            <del>{line.text}</del>
                          ) : line.kind === 'added' ? (
                            <ins>{line.text}</ins>
                          ) : (
                            line.text
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </section>
        </div>
      )}
    </AdminScreen>
  )
}
