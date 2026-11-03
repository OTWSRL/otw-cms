import type { ArchiveTemplateProps, Block, Entry, EntryTemplateProps } from '@otwdesign/sdk'
import { getKernel } from '../runtime/kernel'
import { Blocks } from './blocks'
import { Image } from './image'

/** WordPress's `excerpt_length`: a generated excerpt's words. */
const EXCERPT_WORDS = 55

/** The body's text, block by block, for an excerpt. */
function textOf(blocks: readonly Block[]): string {
  return blocks
    .map((block) =>
      typeof block.text === 'string'
        ? block.text
        : Array.isArray(block.content)
          ? textOf(block.content as Block[])
          : '',
    )
    .join(' ')
}

/** The entry's excerpt, or its body's first 55 words, as `wp_trim_excerpt()` makes one. */
export function excerptOf(entry: Entry): string {
  if (entry.excerpt) return entry.excerpt
  const words = textOf(entry.body).split(/\s+/).filter(Boolean)
  return words.length > EXCERPT_WORDS
    ? `${words.slice(0, EXCERPT_WORDS).join(' ')}…`
    : words.join(' ')
}

async function formatDate(date: Date): Promise<string> {
  const locale = (await getKernel()).setting('site.locale') || 'en-US'
  return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(date)
}

/**
 * An entry's page, as a theme's `single.php`: its title, date and author (not for pages), the
 * body, and its terms. A preview says so. Class names follow the type, as `post_class()` does,
 * for the site's CSS.
 */
export async function EntryTemplate({
  entry,
  type,
  author,
  terms,
  termUrl,
  preview,
  thumbnail,
  media,
}: EntryTemplateProps) {
  const dated = !type.hierarchical && entry.publishedAt
  return (
    <article className={`entry type-${type.name.replace('.', '-')} status-${entry.status}`}>
      {preview && (
        <p className="entry-preview" role="note">
          Preview: visitors can’t see this {type.labels.singular.toLowerCase()}
          {entry.status === 'published' ? ' as it is here' : ` while it’s ${entry.status}`}.
        </p>
      )}
      <header className="entry-header">
        <h1 className="entry-title">{entry.title || '(no title)'}</h1>
        {(dated || author) && (
          <p className="entry-meta">
            {dated && (
              <time dateTime={entry.publishedAt!.toISOString()}>
                {await formatDate(entry.publishedAt!)}
              </time>
            )}
            {dated && author && ' · '}
            {author && <span className="entry-author">{author.name}</span>}
          </p>
        )}
      </header>
      {thumbnail && (
        <figure className="entry-thumbnail">
          {/* The featured image is the first a visitor sees: it loads at once. */}
          <Image item={thumbnail} priority />
        </figure>
      )}
      <div className="entry-content">
        <Blocks blocks={entry.body} media={media} />
      </div>
      {terms.length > 0 && (
        <footer className="entry-terms">
          {terms.map((term, i) => {
            const url = termUrl(term)
            return (
              <span key={term.id}>
                {i > 0 && ', '}
                {url ? <a href={url}>{term.name}</a> : term.name}
              </span>
            )
          })}
        </footer>
      )}
    </article>
  )
}

/**
 * A list of entries, as a theme's `archive.php` and `home.php`: a type's archive, the latest
 * posts, or a term's entries, each with its excerpt, and links to newer and older pages.
 */
export async function ArchiveTemplate({
  title,
  description,
  items,
  page,
  pages,
  pageUrl,
}: ArchiveTemplateProps) {
  const dates = await Promise.all(
    items.map(({ entry }) => (entry.publishedAt ? formatDate(entry.publishedAt) : null)),
  )
  return (
    <section className="archive">
      {title && (
        <header className="archive-header">
          <h1 className="archive-title">{title}</h1>
          {description && <p className="archive-description">{description}</p>}
        </header>
      )}
      {items.length === 0 ? (
        <p className="archive-empty">Nothing has been published here yet.</p>
      ) : (
        items.map(({ entry, url, thumbnail }, i) => (
          <article key={entry.id} className="archive-item">
            {thumbnail && (
              <a
                href={url ?? undefined}
                className="archive-thumbnail"
                tabIndex={-1}
                aria-hidden="true"
              >
                <Image item={thumbnail} size="medium" alt="" />
              </a>
            )}
            <h2 className="entry-title">
              {url ? <a href={url}>{entry.title || '(no title)'}</a> : entry.title}
            </h2>
            {dates[i] && (
              <p className="entry-meta">
                <time dateTime={entry.publishedAt!.toISOString()}>{dates[i]}</time>
              </p>
            )}
            {excerptOf(entry) && <p className="entry-excerpt">{excerptOf(entry)}</p>}
          </article>
        ))
      )}
      {pages > 1 && (
        <nav className="pagination" aria-label="Pages">
          {page > 1 && (
            <a href={pageUrl(page - 1)} rel="prev">
              Newer
            </a>
          )}{' '}
          <span>
            Page {page} of {pages}
          </span>{' '}
          {page < pages && (
            <a href={pageUrl(page + 1)} rel="next">
              Older
            </a>
          )}
        </nav>
      )}
    </section>
  )
}
