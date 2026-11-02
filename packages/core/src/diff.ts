import type { Block, EntryMetaValues, Revision } from '@otw/sdk'

/** One line of a diff: kept, removed from the older text, or added in the newer. */
export interface DiffLine {
  kind: 'same' | 'removed' | 'added'
  text: string
}

/** A field compared between two revisions, as WordPress's revisions screen shows each one. */
export interface FieldDiff {
  field: string
  lines: DiffLine[]
}

/** Past this many cells, two texts are shown whole, one removed and one added, not compared. */
const MAX_CELLS = 4_000_000

/**
 * The lines of `before` and `after`, matched by their longest common subsequence: what's in both
 * is kept, the rest removed or added, in order.
 */
export function diffLines(before: readonly string[], after: readonly string[]): DiffLine[] {
  const n = before.length
  const m = after.length
  if (n * m > MAX_CELLS) {
    return [
      ...before.map((text) => ({ kind: 'removed' as const, text })),
      ...after.map((text) => ({ kind: 'added' as const, text })),
    ]
  }
  // lengths[i][j]: the common subsequence of before[i..] and after[j..].
  const lengths = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lengths[i]![j] =
        before[i] === after[j]
          ? lengths[i + 1]![j + 1]! + 1
          : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!)
    }
  }
  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      lines.push({ kind: 'same', text: before[i]! })
      i++
      j++
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) {
      lines.push({ kind: 'removed', text: before[i++]! })
    } else {
      lines.push({ kind: 'added', text: after[j++]! })
    }
  }
  while (i < n) lines.push({ kind: 'removed', text: before[i++]! })
  while (j < m) lines.push({ kind: 'added', text: after[j++]! })
  return lines
}

/** A block's text, its inline text joined; lists and quotes give a line per block inside. */
function blockLines(block: Block): string[] {
  const children = Array.isArray(block.content) ? (block.content as Block[]) : []
  if (block.type === 'horizontalRule') return ['———']
  if (['bulletList', 'orderedList', 'listItem', 'blockquote'].includes(block.type)) {
    const prefix = block.type === 'blockquote' ? '> ' : block.type === 'listItem' ? '• ' : ''
    return children.flatMap(blockLines).map((line) => prefix + line)
  }
  const text = children
    .map((node) =>
      typeof node.text === 'string' ? node.text : node.type === 'hardBreak' ? '\n' : '',
    )
    .join('')
  const level =
    block.type === 'heading' ? Number((block.attrs as { level?: number })?.level ?? 2) : 0
  return [level > 0 ? `${'#'.repeat(level)} ${text}` : text]
}

/** A body as lines of text, one per block, for comparing. Empty paragraphs are left out. */
export function bodyLines(body: readonly Block[]): string[] {
  return body.flatMap(blockLines).filter((line) => line.trim() !== '')
}

function metaLines(meta: EntryMetaValues): string[] {
  return Object.entries(meta)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
}

/**
 * Two revisions compared field by field: title, excerpt, content and custom fields, those that
 * changed only. `before` is `null` for an entry's first revision, compared with nothing.
 */
export function diffRevisions(before: Revision | null, after: Revision): FieldDiff[] {
  const fields: [string, (revision: Revision) => string[]][] = [
    ['Title', (revision) => (revision.title ? [revision.title] : [])],
    ['Excerpt', (revision) => revision.excerpt.split('\n').filter(Boolean)],
    ['Content', (revision) => bodyLines(revision.body)],
    ['Custom fields', (revision) => metaLines(revision.meta)],
  ]
  return fields.flatMap(([field, lines]) => {
    const diff = diffLines(before ? lines(before) : [], lines(after))
    return diff.some((line) => line.kind !== 'same') ? [{ field, lines: diff }] : []
  })
}
