import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createJobRunner, type JobsRun } from '../src/runtime/job-runner'

const MINUTE = 60_000

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-11-13T10:00:00Z') })
})

afterEach(() => {
  vi.useRealTimers()
})

const inMs = (ms: number) => new Date(Date.now() + ms)

/** A queue that answers each look with the next of `answers`, then "nothing waits". */
function queue(answers: (JobsRun | Error | (() => Promise<JobsRun>))[] = [], recheckMs = 0) {
  const looks: number[] = []
  const problems: string[] = []
  const runner = createJobRunner({
    recheckMs,
    log: (message) => problems.push(message),
    runDue: async () => {
      looks.push(Date.now())
      const answer = answers.shift() ?? { ran: 0, nextDue: null }
      if (answer instanceof Error) throw answer
      return typeof answer === 'function' ? answer() : answer
    },
  })
  return { runner, looks, problems, start: Date.now() }
}

describe('the job runner', () => {
  it('does nothing until a job is due, then looks once', async () => {
    const { runner, looks, start } = queue()
    await vi.advanceTimersByTimeAsync(60 * MINUTE)
    expect(looks).toEqual([])

    runner.wake(inMs(5 * MINUTE))
    await vi.advanceTimersByTimeAsync(5 * MINUTE - 1)
    expect(looks).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(looks).toEqual([start + 65 * MINUTE])

    // Nothing waits: it sleeps until it's woken again.
    await vi.advanceTimersByTimeAsync(24 * 60 * MINUTE)
    expect(looks).toHaveLength(1)
  })

  it('keeps the soonest time it was given', async () => {
    const { runner, looks, start } = queue()
    runner.wake(inMs(10 * MINUTE))
    runner.wake(inMs(2 * MINUTE))
    runner.wake(inMs(30 * MINUTE))
    await vi.advanceTimersByTimeAsync(40 * MINUTE)
    expect(looks).toEqual([start + 2 * MINUTE])
  })

  it('sleeps until the next job the queue names, and goes straight on when more is due', async () => {
    const { runner, looks, start } = queue([
      // Out of time with jobs still due.
      { ran: 50, nextDue: inMs(-1000) },
      { ran: 3, nextDue: inMs(15 * MINUTE) },
    ])
    runner.wake(inMs(0))
    await vi.advanceTimersByTimeAsync(5)
    expect(looks).toHaveLength(2)
    expect(looks[1]! - start).toBeLessThan(5)
    await vi.advanceTimersByTimeAsync(15 * MINUTE)
    expect(looks).toHaveLength(3)
    expect(looks[2]).toBe(start + 15 * MINUTE)
  })

  it('looks again when a job came due while others ran', async () => {
    let finish!: (run: JobsRun) => void
    const { runner, looks } = queue([
      () => new Promise<JobsRun>((resolve) => (finish = resolve)),
      { ran: 1, nextDue: null },
    ])
    const first = runner.look()
    await vi.advanceTimersByTimeAsync(0)
    // The same look, not a second one beside it.
    const second = runner.look()
    expect(looks).toHaveLength(1)
    finish({ ran: 1, nextDue: null })
    await Promise.all([first, second])
    expect(looks).toHaveLength(2)
  })

  it('wakes for a job that is days away', async () => {
    const { runner, looks } = queue([
      { ran: 0, nextDue: inMs(40 * 24 * 60 * MINUTE) },
      { ran: 0, nextDue: inMs(39 * 24 * 60 * MINUTE) },
    ])
    await runner.look()
    // A timer can't sleep 40 days: it looks after a day, and is told the same time again.
    await vi.advanceTimersByTimeAsync(24 * 60 * MINUTE)
    expect(looks).toHaveLength(2)
  })

  it('looks every so often when other servers share the database', async () => {
    const { runner, looks, start } = queue([], MINUTE)
    await runner.look()
    await vi.advanceTimersByTimeAsync(3 * MINUTE)
    expect(looks).toEqual([start, start + MINUTE, start + 2 * MINUTE, start + 3 * MINUTE])
  })

  it('tries again a minute after the queue could not be read', async () => {
    const { runner, looks, problems, start } = queue([new Error('connection refused')])
    await runner.look()
    expect(problems).toEqual(['cms: running the due jobs failed, and is tried again in a minute'])
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(looks).toEqual([start, start + MINUTE])
  })

  it('stops', async () => {
    const { runner, looks } = queue()
    runner.wake(inMs(MINUTE))
    runner.stop()
    runner.wake(inMs(MINUTE))
    await vi.advanceTimersByTimeAsync(5 * MINUTE)
    expect(looks).toEqual([])
  })
})
