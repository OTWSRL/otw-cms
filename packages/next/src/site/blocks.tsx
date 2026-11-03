import { isSafeHref, type Block, type MediaItem } from '@otwdesign/sdk'
import type { ReactNode } from 'react'
import { Image } from './image'

/**
 * An entry's body as HTML: paragraphs, headings, lists, quotes, code, separators and images, with
 * bold, italic, struck-through, code and link formatting. React escapes the text, and a link the
 * editor's schema wouldn't allow is shown as plain text, so no stored content adds markup.
 * Unknown blocks render nothing. A server component: it sends the browser no JavaScript.
 *
 * Images come from `media`, the files templates receive: each with its sizes in `srcset`. A file
 * that's been deleted isn't shown. Without `media`, an image shows its stored address alone.
 */
export function Blocks({
  blocks,
  media,
}: {
  blocks: readonly Block[]
  media?: ReadonlyMap<string, MediaItem>
}) {
  return <>{renderBlocks(blocks, media)}</>
}

type Media = ReadonlyMap<string, MediaItem> | undefined

const HEADINGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const

function children(block: Block): readonly Block[] {
  return Array.isArray(block.content) ? (block.content as Block[]) : []
}

function attr(block: Block, name: string): unknown {
  const attrs = block.attrs
  return typeof attrs === 'object' && attrs !== null
    ? (attrs as Record<string, unknown>)[name]
    : undefined
}

function renderBlocks(blocks: readonly Block[], media: Media): ReactNode {
  return blocks.map((block, index) => renderBlock(block, index, media))
}

/** An image block, as WordPress's `core/image` renders: a figure, at the large size. */
function renderImage(block: Block, key: number, media: Media): ReactNode {
  const id = attr(block, 'id')
  const alt = attr(block, 'alt')
  const text = typeof alt === 'string' ? alt : ''
  if (media) {
    const item = typeof id === 'string' ? media.get(id) : undefined
    if (!item) return null
    return (
      <figure key={key} className="wp-block-image">
        <Image item={item} alt={text} />
      </figure>
    )
  }
  const src = attr(block, 'src')
  const side = (name: string) => {
    const value = attr(block, name)
    return Number.isSafeInteger(value) ? (value as number) : undefined
  }
  if (typeof src !== 'string' || !(src.startsWith('/') || /^https?:\/\//i.test(src))) return null
  return (
    <figure key={key} className="wp-block-image">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={text} width={side('width')} height={side('height')} loading="lazy" />
    </figure>
  )
}

function renderBlock(block: Block, key: number, media: Media): ReactNode {
  switch (block.type) {
    case 'paragraph':
      return <p key={key}>{renderInline(children(block))}</p>
    case 'heading': {
      const level = attr(block, 'level')
      const Tag = (Number.isInteger(level) && HEADINGS[(level as number) - 1]) || 'h2'
      return <Tag key={key}>{renderInline(children(block))}</Tag>
    }
    case 'bulletList':
      return <ul key={key}>{renderBlocks(children(block), media)}</ul>
    case 'orderedList': {
      const start = attr(block, 'start')
      return (
        <ol
          key={key}
          start={Number.isSafeInteger(start) && start !== 1 ? (start as number) : undefined}
        >
          {renderBlocks(children(block), media)}
        </ol>
      )
    }
    case 'listItem':
      return <li key={key}>{renderBlocks(children(block), media)}</li>
    case 'blockquote':
      return <blockquote key={key}>{renderBlocks(children(block), media)}</blockquote>
    case 'image':
      return renderImage(block, key, media)
    case 'codeBlock': {
      const language = attr(block, 'language')
      return (
        <pre key={key}>
          <code className={typeof language === 'string' ? `language-${language}` : undefined}>
            {children(block)
              .map((node) => (typeof node.text === 'string' ? node.text : ''))
              .join('')}
          </code>
        </pre>
      )
    }
    case 'horizontalRule':
      return <hr key={key} />
    default:
      return null
  }
}

function renderInline(nodes: readonly Block[]): ReactNode {
  return nodes.map((node, index) => {
    if (node.type === 'hardBreak') return <br key={index} />
    if (node.type !== 'text' || typeof node.text !== 'string') return null
    const marks = Array.isArray(node.marks) ? (node.marks as Block[]) : []
    // The first mark is outermost, as ProseMirror nests them.
    return marks.reduceRight<ReactNode>((inner, mark) => wrap(mark, inner, index), node.text)
  })
}

function wrap(mark: Block, inner: ReactNode, key: number): ReactNode {
  switch (mark.type) {
    case 'bold':
      return <strong key={key}>{inner}</strong>
    case 'italic':
      return <em key={key}>{inner}</em>
    case 'strike':
      return <s key={key}>{inner}</s>
    case 'code':
      return <code key={key}>{inner}</code>
    case 'link': {
      const href = attr(mark, 'href')
      return typeof href === 'string' && isSafeHref(href) ? (
        <a key={key} href={href}>
          {inner}
        </a>
      ) : (
        inner
      )
    }
    default:
      return inner
  }
}
