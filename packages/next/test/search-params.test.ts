import { describe, expect, it } from 'vitest'
import {
  parseSearchParams,
  pathnameFromSegments,
  serializeSearchParams,
} from '../src/runtime/search-params'

describe('search params', () => {
  it('serializes deterministically and round-trips repeated keys', () => {
    const query = serializeSearchParams({ z: '1', a: ['x', 'y'], skip: undefined })
    expect(query).toBe('a=x&a=y&z=1')
    expect(parseSearchParams(query)).toEqual({ a: ['x', 'y'], z: '1' })
    expect(serializeSearchParams({ a: ['x', 'y'], z: '1' })).toBe(query)
  })

  it('handles an empty query', () => {
    expect(serializeSearchParams({})).toBe('')
    expect(parseSearchParams('')).toEqual({})
  })
})

describe('pathnameFromSegments', () => {
  it('re-encodes decoded segments for the router', () => {
    expect(pathnameFromSegments(undefined)).toBe('/')
    expect(pathnameFromSegments(['product', 'café', 'a/b'])).toBe('/product/caf%C3%A9/a%2Fb')
  })
})
