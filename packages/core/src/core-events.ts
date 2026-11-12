import type { Entry, EntryEventData, MediaEventData, MediaItem } from '@otwdesign/sdk'
import type { HookBus } from './hooks'
import type { EventStore, WebhookService } from './webhooks'

const CORE = 'core'
/** After plugins' own handlers, so an event tells of what they left. */
const LAST = 100

export interface CoreEventDependencies {
  store: EventStore
  hooks: HookBus
  webhooks: Pick<WebhookService, 'emit' | 'hasSubscribers'>
  /** Entries' addresses on the site: `null` for those that have none. */
  permalinks(entries: readonly Entry[]): Promise<Map<string, string | null>>
}

function mediaData(item: MediaItem): MediaEventData {
  return {
    id: item.id,
    file: item.file,
    url: item.url,
    filename: item.filename,
    mimeType: item.mimeType,
    size: item.size,
    authorId: item.authorId,
    entryId: item.entryId,
  }
}

/**
 * Core's events, each told from the action of the same name, in that action's transaction: a
 * delivery is queued only if the change is kept. A handler runs only while a webhook is
 * subscribed to its event; otherwise the action passes it by, at the cost of a lookup in memory.
 */
export function registerCoreEvents(deps: CoreEventDependencies): void {
  const { store, hooks, webhooks } = deps
  const entryData = async (entry: Entry): Promise<EntryEventData> => ({
    id: entry.id,
    type: entry.type,
    status: entry.status,
    slug: entry.slug,
    title: entry.title,
    excerpt: entry.excerpt,
    authorId: entry.authorId,
    parentId: entry.parentId,
    url: (await deps.permalinks([entry])).get(entry.id) ?? null,
    publishedAt: entry.publishedAt?.toISOString() ?? null,
    updatedAt: entry.updatedAt.toISOString(),
  })
  const tell = <P>(name: Parameters<WebhookService['emit']>[0], data: (payload: P) => unknown) =>
    hooks.addAction(
      CORE,
      name,
      async (payload: P) => webhooks.emit(name, await data(payload)),
      LAST,
      () => webhooks.hasSubscribers(name),
    )

  store.define(CORE, 'content.saved', {
    label: 'Entry saved',
    description: 'A post, page or other entry was added or changed, trashed or restored.',
  })
  store.define(CORE, 'content.deleted', {
    label: 'Entry deleted',
    description: 'An entry was deleted for good.',
  })
  store.define(CORE, 'media.uploaded', {
    label: 'File uploaded',
    description: 'A file was added to the media library.',
  })
  store.define(CORE, 'media.deleted', {
    label: 'File deleted',
    description: 'A file was deleted from the media library.',
  })

  tell('content.saved', ({ entry }: { entry: Entry }) => entryData(entry))
  // It's gone, and so is its address.
  tell('content.deleted', async ({ entry }: { entry: Entry }) => ({
    ...(await entryData(entry)),
    url: null,
  }))
  tell('media.uploaded', ({ item }: { item: MediaItem }) => mediaData(item))
  tell('media.deleted', ({ item }: { item: MediaItem }) => mediaData(item))
}
