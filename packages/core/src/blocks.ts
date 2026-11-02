import type { Block } from '@otw/sdk'
import { ContentError, isSafeHref } from '@otw/sdk'

/*
 * The blocks an entry's body may hold: ProseMirror's JSON, as the admin's editor (Tiptap) writes
 * it. Anything posted can be forged, so every save is checked against this schema and rebuilt
 * from what it allows; unknown blocks, marks and attributes are refused or dropped, and links
 * may only point at web pages, email addresses or paths on the site.
 */

const LISTS = new Set(['bulletList', 'orderedList'])
const TEXT_BLOCKS = new Set(['paragraph', 'heading'])
const BLOCKS = new Set([
  ...TEXT_BLOCKS,
  ...LISTS,
  'blockquote',
  'codeBlock',
  'horizontalRule',
  'image',
])
const MARKS = new Set(['bold', 'italic', 'strike', 'code', 'link'])
const MAX_DEPTH = 20
const LANGUAGE = /^[a-z0-9+#-]{1,30}$/i
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_ALT = 500
const MAX_SRC = 2048
const MAX_SIDE = 10_000
function invalid(message: string): never {
  throw new ContentError('invalid_input', message)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The body's blocks, checked and rebuilt with only what the schema allows. */
export function cleanBlocks(value: unknown): Block[] {
  if (!Array.isArray(value)) invalid('The body must be a list of blocks')
  return value.map((block) => cleanBlock(block, 0))
}

function cleanBlock(value: unknown, depth: number): Block {
  if (depth > MAX_DEPTH) invalid('The body nests blocks too deeply')
  if (!isObject(value) || typeof value.type !== 'string' || value.type === '') {
    invalid('Every block in the body needs a type')
  }
  const { type } = value
  if (!BLOCKS.has(type)) invalid(`Unknown block "${type}"`)
  if (type === 'horizontalRule') return { type }
  if (type === 'image') return cleanImage(value.attrs)
  if (type === 'paragraph') return withContent({ type }, inline(value.content, true))
  if (type === 'heading') {
    const level = isObject(value.attrs) ? value.attrs.level : undefined
    if (!Number.isInteger(level) || (level as number) < 1 || (level as number) > 6) {
      invalid('Headings need a level from 1 to 6')
    }
    return withContent({ type, attrs: { level } }, inline(value.content, true))
  }
  if (type === 'codeBlock') {
    const language = isObject(value.attrs) ? value.attrs.language : null
    const clean = typeof language === 'string' && LANGUAGE.test(language) ? language : null
    return withContent({ type, attrs: { language: clean } }, inline(value.content, false))
  }
  if (LISTS.has(type)) {
    const items = children(value.content, `A list`).map((item) => {
      if (!isObject(item) || item.type !== 'listItem') invalid('Lists hold list items')
      return { type: 'listItem', content: blocks(item.content, 'A list item', depth + 1) }
    })
    if (type === 'bulletList') return { type, content: items }
    const start = isObject(value.attrs) ? value.attrs.start : 1
    const clean = Number.isSafeInteger(start) && (start as number) >= 0 ? start : 1
    return { type, attrs: { start: clean }, content: items }
  }
  return { type, content: blocks(value.content, 'A quote', depth + 1) }
}

/** A path on the site or a web address: never `javascript:` or `data:`, which an `<img>` could run or hide. */
function isImageSource(src: string): boolean {
  if (src.length > MAX_SRC || /[\s\p{Cc}"'<>\\]/u.test(src)) return false
  if (src.startsWith('/')) return !src.startsWith('//')
  try {
    const url = new URL(src)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * An image from the media library, as WordPress's image block keeps it: the file's id, which
 * the site uses to find its sizes, its address for the editor, its alternative text, and its
 * size as inserted.
 */
function cleanImage(attrs: unknown): Block {
  if (!isObject(attrs)) invalid('An image needs its file')
  const { id, src, alt = '', width, height } = attrs
  if (typeof id !== 'string' || !UUID.test(id)) {
    invalid('An image must be a file in the media library')
  }
  if (typeof src !== 'string' || !isImageSource(src)) {
    invalid("An image's address must be a path on this site or a web address")
  }
  if (typeof alt !== 'string') invalid('Alternative text must be text')
  const cleanAlt = alt.replace(/\p{Cc}+/gu, ' ').trim()
  if (cleanAlt.length > MAX_ALT) {
    invalid(`Alternative text is limited to ${MAX_ALT} characters`)
  }
  const side = (value: unknown) =>
    Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= MAX_SIDE
      ? (value as number)
      : null
  return {
    type: 'image',
    attrs: { id: id.toLowerCase(), src, alt: cleanAlt, width: side(width), height: side(height) },
  }
}

/** The media library files a body's images show, each once, in order. */
export function imageIds(body: readonly Block[]): string[] {
  const ids = new Set<string>()
  const visit = (blocks: readonly Block[]) => {
    for (const block of blocks) {
      const id = isObject(block.attrs) ? block.attrs.id : undefined
      if (block.type === 'image' && typeof id === 'string') ids.add(id)
      if (Array.isArray(block.content)) visit(block.content as Block[])
    }
  }
  visit(body)
  return [...ids]
}

function children(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) invalid(`${what} needs something in it`)
  return value
}

function blocks(value: unknown, what: string, depth: number): Block[] {
  return children(value, what).map((block) => cleanBlock(block, depth))
}

/** Empty blocks, such as a blank paragraph, have no `content`, as ProseMirror writes them. */
function withContent(block: Block, content: Block[]): Block {
  return content.length > 0 ? { ...block, content } : block
}

/** Text and line breaks; `marks` says whether formatting is allowed (not in code blocks). */
function inline(value: unknown, marks: boolean): Block[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) invalid('A block’s text must be a list')
  return value.map((node) => {
    if (!isObject(node)) invalid('Unknown inline content')
    if (node.type === 'hardBreak' && marks) return { type: 'hardBreak' }
    if (node.type !== 'text') invalid(`Unknown inline content "${String(node.type)}"`)
    if (typeof node.text !== 'string' || node.text === '') invalid('Text must not be empty')
    const cleanMarks = marks ? cleanMarksOf(node.marks) : []
    return cleanMarks.length > 0
      ? { type: 'text', text: node.text, marks: cleanMarks }
      : { type: 'text', text: node.text }
  })
}

function cleanMarksOf(value: unknown): Block[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) invalid('Formatting must be a list')
  const seen = new Set<string>()
  return value.flatMap((mark): Block[] => {
    if (!isObject(mark) || typeof mark.type !== 'string' || !MARKS.has(mark.type)) {
      invalid(`Unknown formatting "${isObject(mark) ? String(mark.type) : ''}"`)
    }
    if (seen.has(mark.type)) return []
    seen.add(mark.type)
    if (mark.type !== 'link') return [{ type: mark.type }]
    const href =
      isObject(mark.attrs) && typeof mark.attrs.href === 'string' ? mark.attrs.href.trim() : ''
    if (!isSafeHref(href)) invalid('Links must be web or email addresses, or paths on this site')
    return [{ type: 'link', attrs: { href } }]
  })
}
