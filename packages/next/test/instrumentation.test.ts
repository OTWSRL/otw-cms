import { afterEach, expect, it, vi } from 'vitest'

// Next.js compiles the site's instrumentation.ts for the Edge runtime too, where the CMS's
// Node-only code (node:crypto, process.memoryUsage) must stay out.
const loaded = vi.hoisted(() => ({ tracing: false }))
vi.mock('../src/runtime/tracing', () => {
  loaded.tracing = true
  return { registerTracing: vi.fn() }
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
  loaded.tracing = false
})

it('loads nothing Node-only on the Edge runtime', async () => {
  vi.stubEnv('NEXT_RUNTIME', 'edge')
  const { register } = await import('../src/instrumentation')
  await register()
  expect(loaded.tracing).toBe(false)
})

it('installs tracing on the Node.js runtime', async () => {
  vi.stubEnv('NEXT_RUNTIME', 'nodejs')
  const { register } = await import('../src/instrumentation')
  await register()
  const { registerTracing } = await import('../src/runtime/tracing')
  expect(registerTracing).toHaveBeenCalledOnce()
})
