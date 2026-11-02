import type { Revision } from '@otw/sdk'
import { describe, expect, it } from 'vitest'
import { bodyLines, diffLines, diffRevisions } from '../src/diff'

const marks = (lines: ReturnType<typeof diffLines>) =>
  lines.map((line) => `${{ same: ' ', removed: '-', added: '+' }[line.kind]}${line.text}`)

describe('diffLines', () => {
  it('keeps what both have, and removes and adds the rest in order', () => {
    expect(marks(diffLines(['a', 'b', 'c', 'd'], ['a', 'c', 'x', 'd']))).toEqual([
      ' a',
      '-b',
      ' c',
      '+x',
      ' d',
    ])
    expect(marks(diffLines([], ['new']))).toEqual(['+new'])
    expect(marks(diffLines(['old'], []))).toEqual(['-old'])
    expect(marks(diffLines(['same'], ['same']))).toEqual([' same'])
  })

  it('shows texts too long to compare whole, removed then added', () => {
    const many = Array.from({ length: 2500 }, (_, i) => `line ${i}`)
    const lines = diffLines(many, [...many].reverse())
    expect(lines.filter((line) => line.kind === 'removed')).toHaveLength(2500)
    expect(lines.filter((line) => line.kind === 'added')).toHaveLength(2500)
  })
})

describe('bodyLines', () => {
  it('gives a line of text per block, lists and quotes marked', () => {
    expect(
      bodyLines([
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Bold', marks: [{ type: 'bold' }] },
            { type: 'text', text: ' text' },
          ],
        },
        { type: 'paragraph' },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }],
            },
          ],
        },
        {
          type: 'blockquote',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'q' }] }],
        },
        { type: 'horizontalRule' },
      ]),
    ).toEqual(['## Title', 'Bold text', '• one', '> q', '———'])
  })

  it('names images by their alternative text', () => {
    const image = (alt: string) => ({ type: 'image', attrs: { id: 'x', src: '/a.jpg', alt } })
    expect(bodyLines([image('A boat'), image('')])).toEqual(['[Image: A boat]', '[Image]'])
  })
})

describe('diffRevisions', () => {
  const revision = (fields: Partial<Revision>): Revision => ({
    id: 'r',
    entryId: 'e',
    authorId: null,
    title: 'Title',
    body: [],
    excerpt: '',
    meta: {},
    createdAt: new Date(),
    ...fields,
  })

  it('compares only the fields that changed', () => {
    const before = revision({ title: 'Old', meta: { 'x.a': 1 } as never })
    const after = revision({ title: 'New', meta: { 'x.a': 2 } as never })
    expect(diffRevisions(before, after)).toEqual([
      {
        field: 'Title',
        lines: [
          { kind: 'removed', text: 'Old' },
          { kind: 'added', text: 'New' },
        ],
      },
      {
        field: 'Custom fields',
        lines: [
          { kind: 'removed', text: 'x.a: 1' },
          { kind: 'added', text: 'x.a: 2' },
        ],
      },
    ])
  })

  it('shows a first revision as all added', () => {
    expect(diffRevisions(null, revision({ title: 'First' }))).toEqual([
      { field: 'Title', lines: [{ kind: 'added', text: 'First' }] },
    ])
  })
})
