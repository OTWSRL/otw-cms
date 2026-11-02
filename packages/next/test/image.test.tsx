import type { Block, MediaItem } from '@otw/sdk'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Blocks } from '../src/site/blocks'
import { Image, srcSetOf } from '../src/site/image'

const size = (name: string, width: number, height: number) => ({
  file: `2026/11/boat-${name}.jpg`,
  url: `/uploads/2026/11/boat-${width}x${height}.jpg`,
  width,
  height,
  mimeType: 'image/jpeg',
  size: 1000,
})

/** A 2560 × 1707 photo with WordPress's sizes, as an upload of a big one leaves it. */
const boat: MediaItem = {
  id: '00000000-0000-4000-8000-0000000000b0',
  authorId: null,
  entryId: null,
  file: '2026/11/boat-scaled.jpg',
  url: '/uploads/2026/11/boat-scaled.jpg',
  originalFile: '2026/11/boat.jpg',
  originalUrl: '/uploads/2026/11/boat.jpg',
  filename: 'Boat.jpg',
  mimeType: 'image/jpeg',
  kind: 'image',
  size: 400_000,
  width: 2560,
  height: 1707,
  sizes: {
    thumbnail: size('thumbnail', 150, 150),
    medium: size('medium', 300, 200),
    medium_large: size('medium_large', 768, 512),
    large: size('large', 1024, 683),
    '1536x1536': size('1536', 1536, 1024),
    '2048x2048': size('2048', 2048, 1366),
  },
  title: 'Boat',
  alt: 'A boat at its mooring',
  caption: '',
  description: '',
  createdAt: new Date(),
  updatedAt: new Date(),
}

describe('Image', () => {
  it('writes the size asked for, and its same-shaped sizes up to 2048 in srcset', () => {
    const html = renderToStaticMarkup(<Image item={boat} />)
    expect(html).toContain('src="/uploads/2026/11/boat-1024x683.jpg"')
    expect(html).toContain('width="1024" height="683"')
    expect(html).toContain(
      'srcSet="/uploads/2026/11/boat-300x200.jpg 300w, /uploads/2026/11/boat-768x512.jpg 768w, /uploads/2026/11/boat-1024x683.jpg 1024w, /uploads/2026/11/boat-1536x1024.jpg 1536w, /uploads/2026/11/boat-2048x1366.jpg 2048w"',
    )
    // The cropped thumbnail is another shape, and the 2560 file is past the srcset limit.
    expect(html).not.toContain('150w')
    expect(html).not.toContain('2560w')
    expect(html).toContain('sizes="(max-width: 1024px) 100vw, 1024px"')
    expect(html).toContain('alt="A boat at its mooring"')
    expect(html).toContain('loading="lazy"')
  })

  it('loads a priority image at once, and leaves srcset out when there’s one file', () => {
    expect(renderToStaticMarkup(<Image item={boat} priority />)).toContain('loading="eager"')
    const small = { ...boat, sizes: {}, url: '/uploads/a.jpg', width: 120, height: 80 }
    expect(srcSetOf(small, { url: small.url, width: 120, height: 80 })).toBeUndefined()
    const html = renderToStaticMarkup(<Image item={small} alt="" />)
    expect(html).toContain('src="/uploads/a.jpg"')
    expect(html).not.toContain('srcSet')
    expect(html).toContain('alt=""')
  })
})

describe('image blocks', () => {
  const block = (id: string, src = '/uploads/2026/11/boat-1024x683.jpg'): Block => ({
    type: 'image',
    attrs: { id, src, alt: 'Moored', width: 1024, height: 683 },
  })

  it('show the file with its sizes, and the block’s own alternative text', () => {
    const html = renderToStaticMarkup(
      <Blocks blocks={[block(boat.id)]} media={new Map([[boat.id, boat]])} />,
    )
    expect(html).toMatch(
      /^<figure class="wp-block-image"><img src="\/uploads\/2026\/11\/boat-1024x683\.jpg"/,
    )
    expect(html).toContain('srcSet=')
    expect(html).toContain('alt="Moored"')
  })

  it('leave out an image whose file was deleted', () => {
    const html = renderToStaticMarkup(
      <Blocks blocks={[block('00000000-0000-4000-8000-0000000000ff')]} media={new Map()} />,
    )
    expect(html).toBe('')
  })

  it('show the stored address alone when a template passes no media, but never a script', () => {
    expect(renderToStaticMarkup(<Blocks blocks={[block(boat.id)]} />)).toBe(
      '<figure class="wp-block-image"><img src="/uploads/2026/11/boat-1024x683.jpg" alt="Moored" width="1024" height="683" loading="lazy"/></figure>',
    )
    expect(renderToStaticMarkup(<Blocks blocks={[block(boat.id, 'javascript:alert(1)')]} />)).toBe(
      '',
    )
  })
})
