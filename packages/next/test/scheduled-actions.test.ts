import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const { fromNow, recurrence } = await import('../src/admin/screens/scheduled-actions')

describe('Scheduled Actions', () => {
  it('names how often an action repeats in its largest whole unit', () => {
    expect(recurrence(null)).toBe('Non-repeating')
    expect(recurrence(60)).toBe('Every minute')
    expect(recurrence(900)).toBe('Every 15 minutes')
    expect(recurrence(3600)).toBe('Every hour')
    expect(recurrence(6 * 3600)).toBe('Every 6 hours')
    expect(recurrence(86_400)).toBe('Every day')
    expect(recurrence(7 * 86_400)).toBe('Every 7 days')
    expect(recurrence(90)).toBe('Every 90 seconds')
    expect(recurrence(5400)).toBe('Every 90 minutes')
  })

  it('says how far a time is from now', () => {
    const now = Date.parse('2026-11-13T10:00:00Z')
    const at = (seconds: number) => fromNow(new Date(now + seconds * 1000), now)
    expect(at(0)).toBe('Now')
    expect(at(1)).toBe('In 1 second')
    expect(at(59)).toBe('In 59 seconds')
    expect(at(60)).toBe('In 1 minute')
    expect(at(5 * 60 + 20)).toBe('In 5 minutes')
    expect(at(23 * 3600 + 59 * 60)).toBe('In 23 hours')
    expect(at(86_400)).toBe('In 1 day')
    expect(at(-30)).toBe('30 seconds ago')
    expect(at(-2 * 3600)).toBe('2 hours ago')
    expect(at(-3 * 86_400 - 5)).toBe('3 days ago')
  })
})
