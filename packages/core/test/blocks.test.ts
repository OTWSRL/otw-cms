import { ContentError, isSafeHref } from '@otw/sdk'
import { describe, expect, it } from 'vitest'
import { cleanBlocks } from '../src/blocks'

const text = (value: string, marks?: unknown[]) => ({ type: 'text', text: value, marks })
const paragraph = (...content: unknown[]) => ({ type: 'paragraph', content })

describe('cleanBlocks', () => {
  it('keeps what the editor writes, and nothing it does not', () => {
    const body = [
      { type: 'heading', attrs: { level: 2, id: 'x', textAlign: 'left' }, content: [text('Hi')] },
      paragraph(
        text('bold', [{ type: 'bold' }, { type: 'bold' }]),
        { type: 'hardBreak' },
        text('link', [
          { type: 'link', attrs: { href: ' https://example.com ', target: '_blank' } },
        ]),
      ),
      { type: 'paragraph' },
      {
        type: 'orderedList',
        attrs: { start: 3, type: null },
        content: [{ type: 'listItem', content: [paragraph(text('one'))] }],
      },
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              paragraph(text('a')),
              {
                type: 'bulletList',
                content: [{ type: 'listItem', content: [paragraph(text('b'))] }],
              },
            ],
          },
        ],
      },
      { type: 'blockquote', content: [{ type: 'blockquote', content: [paragraph(text('q'))] }] },
      { type: 'codeBlock', attrs: { language: 'ts' }, content: [text('let a = 1')] },
      { type: 'codeBlock', attrs: { language: '<script>' }, content: [text('x')] },
      { type: 'horizontalRule', attrs: { color: 'red' } },
    ]
    expect(cleanBlocks(body)).toEqual([
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Hi' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
          { type: 'hardBreak' },
          {
            type: 'text',
            text: 'link',
            marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
          },
        ],
      },
      { type: 'paragraph' },
      {
        type: 'orderedList',
        attrs: { start: 3 },
        content: [{ type: 'listItem', content: [paragraph({ type: 'text', text: 'one' })] }],
      },
      body[4],
      body[5],
      {
        type: 'codeBlock',
        attrs: { language: 'ts' },
        content: [{ type: 'text', text: 'let a = 1' }],
      },
      { type: 'codeBlock', attrs: { language: null }, content: [{ type: 'text', text: 'x' }] },
      { type: 'horizontalRule' },
    ])
  })

  it.each([
    ['not a list', { type: 'paragraph' }, 'list of blocks'],
    ['an unknown block', [{ type: 'script' }], 'Unknown block "script"'],
    ['a list item on its own', [{ type: 'listItem', content: [] }], 'Unknown block "listItem"'],
    ['a heading without a level', [{ type: 'heading' }], 'level from 1 to 6'],
    ['an empty list', [{ type: 'bulletList', content: [] }], 'needs something in it'],
    [
      'a list of paragraphs',
      [{ type: 'bulletList', content: [paragraph(text('x'))] }],
      'list items',
    ],
    ['empty text', [paragraph(text(''))], 'must not be empty'],
    ['an image', [paragraph({ type: 'image', attrs: { src: 'x' } })], 'Unknown inline content'],
    ['unknown formatting', [paragraph(text('x', [{ type: 'underline' }]))], 'Unknown formatting'],
    ['formatted code', [{ type: 'codeBlock', content: [{ type: 'hardBreak' }] }], 'Unknown inline'],
    [
      'a javascript: link',
      [paragraph(text('x', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }]))],
      'Links must be',
    ],
  ])('refuses %s', (_what, body, message) => {
    expect(() => cleanBlocks(body)).toThrow(ContentError)
    expect(() => cleanBlocks(body)).toThrow(message)
  })

  it('refuses nesting deeper than an editor would', () => {
    let block: unknown = paragraph(text('deep'))
    for (let i = 0; i < 25; i++) block = { type: 'blockquote', content: [block] }
    expect(() => cleanBlocks([block])).toThrow('nests blocks too deeply')
  })
})

describe('isSafeHref', () => {
  it.each([
    'https://example.com/a?b#c',
    'HTTP://EXAMPLE.COM',
    'mailto:a@b.co',
    '/about',
    '/a:b',
    '#top',
    '?page=2',
    'docs/page.html',
    '../up',
  ])('allows %s', (href) => {
    expect(isSafeHref(href)).toBe(true)
  })

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'java\tscript:alert(1)',
    ' javascript:alert(1)',
    'data:text/html,<script>',
    'vbscript:x',
    '//evil.example',
    '&#106;avascript:alert(1)',
    'ftp://example.com',
    'a b',
    '',
  ])('refuses %j', (href) => {
    expect(isSafeHref(href)).toBe(false)
  })
})
