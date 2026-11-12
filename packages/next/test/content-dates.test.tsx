import type { Entry } from '@otwdesign/sdk'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { entryDate, schedules } from '../src/admin/screens/content-dates'

const HOUR = 3_600_000

function entry(fields: Partial<Entry>): Entry {
  const then = new Date('2026-01-02T03:04:05Z')
  return {
    id: '0b0e4f0e-5a35-4b53-9d0e-3c2f1a7b9c11',
    type: 'core.post',
    status: 'draft',
    slug: '',
    title: 'A post',
    body: [],
    excerpt: '',
    authorId: null,
    parentId: null,
    position: 0,
    thumbnailId: null,
    publishedAt: null,
    createdAt: then,
    updatedAt: then,
    trashedFrom: null,
    trashedAt: null,
    meta: {},
    ...fields,
  }
}

const column = (fields: Partial<Entry>) => renderToStaticMarkup(entryDate(entry(fields), 'en-US'))

describe('the list’s Date column', () => {
  it('says when an entry was published, or last changed if it wasn’t', () => {
    const publishedAt = new Date('2026-03-04T05:06:00Z')
    expect(column({ status: 'published', publishedAt })).toBe(
      'Published<br/><time dateTime="2026-03-04T05:06:00.000Z">Mar 4, 2026, 5:06 AM UTC</time>',
    )
    expect(column({ status: 'draft' })).toContain('Last Modified<br/>')
    // A draft keeps a date it was given, but hasn't been published on it.
    expect(column({ status: 'draft', publishedAt })).toContain('Last Modified<br/>')
  })

  it('says when a scheduled entry will be published, in the trash too', () => {
    const publishedAt = new Date(Date.now() + HOUR)
    expect(column({ status: 'scheduled', publishedAt })).toContain(
      `Scheduled<br/><time dateTime="${publishedAt.toISOString()}">`,
    )
    expect(column({ status: 'trash', trashedFrom: 'scheduled', publishedAt })).toContain(
      'Scheduled<br/>',
    )
  })

  it('says a scheduled entry missed its date, once it’s a minute late, as WordPress does', () => {
    const late = column({ status: 'scheduled', publishedAt: new Date(Date.now() - HOUR) })
    expect(late).toContain('<strong class="error-message">Missed schedule</strong><br/>')
    // About to be published by the runner: not yet missed.
    const due = column({ status: 'scheduled', publishedAt: new Date(Date.now() - 5000) })
    expect(due).toContain('Scheduled<br/>')
    // In the trash, nothing was going to publish it.
    const binned = column({
      status: 'trash',
      trashedFrom: 'scheduled',
      publishedAt: new Date(Date.now() - HOUR),
    })
    expect(binned).toContain('Scheduled<br/>')
  })
})

describe('a publish date', () => {
  it('schedules when it’s a minute or more ahead', () => {
    const now = Date.parse('2026-11-13T10:00:00Z')
    const at = (seconds: number) => schedules(new Date(now + seconds * 1000), now)
    expect(at(3600)).toBe(true)
    expect(at(60)).toBe(true)
    expect(at(59)).toBe(false)
    expect(at(-60)).toBe(false)
    expect(schedules(null, now)).toBe(false)
    expect(schedules(undefined, now)).toBe(false)
  })
})
