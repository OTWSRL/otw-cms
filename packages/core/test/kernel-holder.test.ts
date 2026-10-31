import { describe, expect, it } from 'vitest'
import type { Kernel } from '../src/kernel'
import { createKernelHolder } from '../src/kernel-holder'

function harness() {
  const state = { generation: 0, now: 0, local: 0, boots: 0, checks: 0, failNextBoot: false }
  const holder = createKernelHolder({
    recheckMs: 1000,
    now: () => state.now,
    localChanges: () => state.local,
    boot: async () => {
      state.boots++
      if (state.failNextBoot) {
        state.failNextBoot = false
        throw new Error('database down')
      }
      const generation = state.generation
      return {
        generation,
        isCurrent: async () => {
          state.checks++
          return state.generation === generation
        },
      } as Kernel
    },
  })
  return { state, holder }
}

describe('createKernelHolder', () => {
  it('reuses one kernel and only rechecks after the interval', async () => {
    const { state, holder } = harness()
    const first = await holder.get()
    state.now = 999
    expect(await holder.get()).toBe(first)
    expect(state.checks).toBe(0)

    state.now = 1000
    expect(await holder.get()).toBe(first)
    expect(state.checks).toBe(1)
    expect(state.boots).toBe(1)
  })

  it('reboots when another instance changed the generation', async () => {
    const { state, holder } = harness()
    const first = await holder.get()
    state.generation = 1
    state.now = 5000
    const second = await holder.get()
    expect(second).not.toBe(first)
    expect(second.generation).toBe(1)
    expect(state.boots).toBe(2)
  })

  it('checks immediately after a change in this process', async () => {
    const { state, holder } = harness()
    await holder.get()
    state.generation = 1
    state.local = 1
    expect((await holder.get()).generation).toBe(1)
  })

  it('shares one check between concurrent requests', async () => {
    const { state, holder } = harness()
    await holder.get()
    state.generation = 1
    state.now = 5000
    const kernels = await Promise.all([holder.get(), holder.get(), holder.get()])
    expect(new Set(kernels).size).toBe(1)
    expect(state.checks).toBe(1)
    expect(state.boots).toBe(2)
  })

  it('does not cache a failed boot', async () => {
    const { state, holder } = harness()
    state.failNextBoot = true
    await expect(holder.get()).rejects.toThrow('database down')
    await expect(holder.get()).resolves.toBeDefined()
    expect(state.boots).toBe(2)
  })
})
