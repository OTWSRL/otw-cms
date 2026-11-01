import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BrandMark, BrandName } from '../src/admin/brand-mark'

describe('BrandMark', () => {
  it('draws the CMS’s mark, or the brand’s logo in its place', () => {
    expect(renderToStaticMarkup(<BrandMark brand={{ name: 'OTW CMS' }} />)).toMatch(/^<svg /)
    expect(
      renderToStaticMarkup(<BrandMark brand={{ name: 'Acme', logo: '/brand/logo.svg' }} />),
    ).toContain('<img src="/brand/logo.svg" alt="" width="84" height="84"/>')
  })
})

describe('BrandName', () => {
  it('links the name to the brand’s site when it has one', () => {
    expect(renderToStaticMarkup(<BrandName brand={{ name: 'OTW CMS' }} />)).toBe('OTW CMS')
    expect(
      renderToStaticMarkup(
        <BrandName brand={{ name: 'Acme & Co', url: 'https://acme.example' }} />,
      ),
    ).toBe('<a href="https://acme.example">Acme &amp; Co</a>')
  })
})
