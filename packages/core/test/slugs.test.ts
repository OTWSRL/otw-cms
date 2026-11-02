import { describe, expect, it } from 'vitest'
import { firstFreeSlug, MAX_SLUG_LENGTH, slugify, slugStem } from '../src/slugs'

describe('slugify', () => {
  it.each([
    ['Hello World', 'hello-world'],
    ['  Café crème brûlée!  ', 'cafe-creme-brulee'],
    ["Don't stop", 'dont-stop'],
    ['Rock’n’roll', 'rocknroll'],
    ['C++ & Rust: 2026', 'c-rust-2026'],
    ['already-a-slug', 'already-a-slug'],
    ['under_score', 'under-score'],
    ['---', ''],
    ['', ''],
    // Other scripts keep their letters and marks, as WordPress keeps them (percent-encoded).
    ['Привет мир', 'привет-мир'],
    ['こんにちは 世界', 'こんにちは-世界'],
    ['हिंदी भाषा', 'हिंदी-भाषा'],
    ['ガイド', 'ガイド'],
  ])('%j → %j', (text, slug) => {
    expect(slugify(text)).toBe(slug)
  })

  it(`keeps to ${MAX_SLUG_LENGTH} characters, without cutting a letter or ending in a dash`, () => {
    expect(slugify('a'.repeat(300))).toBe('a'.repeat(MAX_SLUG_LENGTH))
    expect(slugify(`${'a'.repeat(199)} b`)).toBe('a'.repeat(199))
    expect(Array.from(slugify('ж'.repeat(300)))).toHaveLength(MAX_SLUG_LENGTH)
  })
})

describe('firstFreeSlug', () => {
  it('keeps a free slug, and numbers a taken one from 2, as WordPress does', () => {
    expect(firstFreeSlug('about', new Set())).toBe('about')
    expect(firstFreeSlug('about', new Set(['about']))).toBe('about-2')
    expect(firstFreeSlug('about', new Set(['about', 'about-2', 'about-3']))).toBe('about-4')
    expect(firstFreeSlug('about', new Set(['about-2']))).toBe('about')
  })

  it('shortens a long slug to fit its number', () => {
    const long = 'a'.repeat(MAX_SLUG_LENGTH)
    const free = firstFreeSlug(long, new Set([long]))
    expect(free).toBe(`${'a'.repeat(MAX_SLUG_LENGTH - 2)}-2`)
    expect(free.startsWith(slugStem(long))).toBe(true)
  })
})
