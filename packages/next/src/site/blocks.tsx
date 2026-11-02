import { isSafeHref, type Block } from '@otw/sdk'
import type { ReactNode } from 'react'

/**
 * An entry's body as HTML: paragraphs, headings, lists, quotes, code and separators, with bold,
 * italic, struck-through, code and link formatting. React escapes the text, and a link the
 * editor's schema wouldn't allow is shown as plain text, so no stored content adds markup.
 * Unknown blocks render nothing. A server component: it sends the browser no JavaScript.
 */
export function Blocks({ blocks }: { blocks: readonly Block[] }) {
  return <>{blocks.map((block, index) => renderBlock(block, index))}</>
}

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

function renderBlocks(blocks: readonly Block[]): ReactNode {
  return blocks.map((block, index) => renderBlock(block, index))
}

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.type) {
    case 'paragraph':
      return <p key={key}>{renderInline(children(block))}</p>
    case 'heading': {
      const level = attr(block, 'level')
      const Tag = (Number.isInteger(level) && HEADINGS[(level as number) - 1]) || 'h2'
      return <Tag key={key}>{renderInline(children(block))}</Tag>
    }
    case 'bulletList':
      return <ul key={key}>{renderBlocks(children(block))}</ul>
    case 'orderedList': {
      const start = attr(block, 'start')
      return (
        <ol
          key={key}
          start={Number.isSafeInteger(start) && start !== 1 ? (start as number) : undefined}
        >
          {renderBlocks(children(block))}
        </ol>
      )
    }
    case 'listItem':
      return <li key={key}>{renderBlocks(children(block))}</li>
    case 'blockquote':
      return <blockquote key={key}>{renderBlocks(children(block))}</blockquote>
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
