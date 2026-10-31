import { describe, expect, it, vi } from 'vitest'
import { HookError } from '../src/errors'
import { HookBus } from '../src/hooks'
import { memoryLogger } from './helpers'

function createBus(isolate = <T>(fn: () => Promise<T>) => fn()) {
  const logger = memoryLogger()
  let sealed = false
  const bus = new HookBus({
    logger,
    isolate,
    assertOpen: (what) => {
      if (sealed) throw new Error(`sealed: ${what}`)
    },
  })
  return { bus, logger, seal: () => (sealed = true) }
}

describe('HookBus filters', () => {
  it('chains handlers by priority, then registration order', async () => {
    const { bus } = createBus()
    bus.addFilter('a', 'title', (v: string) => `${v}-default1`)
    bus.addFilter('b', 'title', (v: string) => `${v}-late`, 20)
    bus.addFilter('c', 'title', async (v: string) => `${v}-early`, 5)
    bus.addFilter('d', 'title', (v: string) => `${v}-default2`)
    expect(await bus.applyFilters('title', 'x', {})).toBe('x-early-default1-default2-late')
  })

  it('passes the context to every handler', async () => {
    const { bus } = createBus()
    const handler = vi.fn((v: number) => v)
    bus.addFilter('a', 'n', handler)
    await bus.applyFilters('n', 1, { cart: 'c1' })
    expect(handler).toHaveBeenCalledWith(1, { cart: 'c1' })
  })

  it('returns the value unchanged when nothing is registered', async () => {
    const { bus } = createBus()
    expect(await bus.applyFilters('nothing', 42, {})).toBe(42)
  })

  it('wraps a failing filter in a HookError naming the plugin', async () => {
    const { bus } = createBus()
    bus.addFilter('broken-plugin', 'title', () => {
      throw new Error('boom')
    })
    const error = await bus.applyFilters('title', 'x', {}).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HookError)
    expect(error).toMatchObject({ pluginId: 'broken-plugin', hook: 'title' })
    expect((error as Error).message).toContain('boom')
  })

  it('rejects non-function handlers and non-finite priorities', () => {
    const { bus } = createBus()
    expect(() => bus.addFilter('a', 'x', 'nope' as never)).toThrow(TypeError)
    expect(() => bus.addFilter('a', 'x', () => 1, Number.NaN)).toThrow('finite')
  })
})

describe('HookBus actions', () => {
  it('runs every handler in priority order', async () => {
    const { bus } = createBus()
    const calls: string[] = []
    bus.addAction('a', 'saved', () => void calls.push('a'))
    bus.addAction('b', 'saved', async () => void calls.push('b'), 1)
    await bus.doAction('saved', {})
    expect(calls).toEqual(['b', 'a'])
  })

  it('logs a failing handler with its plugin and keeps going', async () => {
    const { bus, logger } = createBus()
    const after = vi.fn()
    bus.addAction('flaky', 'saved', () => {
      throw new Error('nope')
    })
    bus.addAction('steady', 'saved', after)
    await bus.doAction('saved', { id: 1 })
    expect(after).toHaveBeenCalledWith({ id: 1 })
    expect(logger.entries).toHaveLength(1)
    expect(logger.entries[0]).toMatchObject({
      level: 'error',
      context: { plugin: 'flaky', hook: 'saved' },
    })
  })

  it('runs each handler through the isolation wrapper', async () => {
    let isolated = 0
    const { bus } = createBus(<T>(fn: () => Promise<T>) => {
      isolated++
      return fn()
    })
    bus.addAction('a', 'saved', () => undefined)
    bus.addAction('b', 'saved', () => undefined)
    await bus.doAction('saved', {})
    expect(isolated).toBe(2)
  })
})

describe('HookBus lifecycle', () => {
  it('refuses registrations once sealed', () => {
    const { bus, seal } = createBus()
    seal()
    expect(() => bus.addFilter('a', 'x', (v: unknown) => v)).toThrow('sealed: filter "x"')
    expect(() => bus.addAction('a', 'y', () => undefined)).toThrow('sealed: action "y"')
  })
})
