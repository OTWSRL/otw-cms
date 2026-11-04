import { expect, it, vi } from 'vitest'

// Modules a server needs only for some sites: sharp for uploads, OpenTelemetry's SDK for tracing.
const loaded = vi.hoisted(() => new Set<string>())

vi.mock('sharp', async (importOriginal) => {
  loaded.add('sharp')
  return importOriginal()
})
vi.mock('@opentelemetry/sdk-trace', async (importOriginal) => {
  loaded.add('@opentelemetry/sdk-trace')
  return importOriginal()
})
vi.mock('@opentelemetry/context-async-hooks', async (importOriginal) => {
  loaded.add('@opentelemetry/context-async-hooks')
  return importOriginal()
})

// A 1×1 PNG, written out so that making one doesn't load sharp first.
const PIXEL = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
)

it('starts without sharp or OpenTelemetry’s SDK, loading each when first needed', async () => {
  const core = await import('../src/index')
  expect([...loaded]).toEqual([])

  const { readImage } = await import('../src/media-images')
  expect(await readImage(PIXEL)).toEqual({ mimeType: 'image/png', width: 1, height: 1 })
  expect([...loaded]).toEqual(['sharp'])

  const collector = new core.TraceCollector()
  expect(core.registerTracerProvider(collector)).toBe(true)
  expect(loaded.has('@opentelemetry/sdk-trace')).toBe(false)
  await collector.setEnabled(true)
  expect(loaded).toContain('@opentelemetry/sdk-trace')
  expect(loaded).toContain('@opentelemetry/context-async-hooks')
})
