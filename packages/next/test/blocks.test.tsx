import type { Block } from '@otwdesign/sdk'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Blocks } from '../src/site/blocks'

const html = (blocks: Block[]) => renderToStaticMarkup(<Blocks blocks={blocks} />)
const text = (value: string, marks?: Block[]): Block => ({ type: 'text', text: value, marks })

describe('Blocks', () => {
  it("renders the editor's blocks as HTML", () => {
    expect(
      html([
        { type: 'heading', attrs: { level: 3 }, content: [text('Title')] },
        {
          type: 'paragraph',
          content: [
            text('Bold and italic', [{ type: 'bold' }, { type: 'italic' }]),
            { type: 'hardBreak' },
            text('gone', [{ type: 'strike' }]),
            text(' x', [{ type: 'code' }]),
          ],
        },
        { type: 'paragraph' },
        {
          type: 'orderedList',
          attrs: { start: 3 },
          content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [text('c')] }] }],
        },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] },
        { type: 'blockquote', content: [{ type: 'paragraph', content: [text('q')] }] },
        { type: 'codeBlock', attrs: { language: 'ts' }, content: [text('a < b')] },
        { type: 'horizontalRule' },
      ]),
    ).toBe(
      '<h3>Title</h3>' +
        '<p><strong><em>Bold and italic</em></strong><br/><s>gone</s><code> x</code></p>' +
        '<p></p>' +
        '<ol start="3"><li><p>c</p></li></ol>' +
        '<ul><li><p></p></li></ul>' +
        '<blockquote><p>q</p></blockquote>' +
        '<pre><code class="language-ts">a &lt; b</code></pre>' +
        '<hr/>',
    )
  })

  it('escapes text, and shows unsafe links and unknown blocks as nothing more than text', () => {
    expect(
      html([
        {
          type: 'paragraph',
          content: [
            text('<script>alert(1)</script>'),
            text('safe', [{ type: 'link', attrs: { href: '/about' } }]),
            text('unsafe', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }]),
          ],
        },
        { type: 'script', content: [text('alert(1)')] },
        { type: 'heading', attrs: { level: '1 onclick=x' }, content: [text('h')] },
      ]),
    ).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;<a href="/about">safe</a>unsafe</p><h2>h</h2>')
  })
})
