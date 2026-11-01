import { trace } from '@opentelemetry/api'
import { TracerProvider } from '@opentelemetry/sdk-trace'
import { expect, it, vi } from 'vitest'
import { cmsTracing, registerTracing, traceCollector } from '../src/runtime/tracing'

it('leaves a site’s own OpenTelemetry setup alone, and says how to add the CMS’s', () => {
  trace.setGlobalTracerProvider(new TracerProvider())
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  expect(registerTracing()).toBeUndefined()
  expect(traceCollector()).toBeUndefined()
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('cmsTracing()'))

  // What the warning says to do: the site adds the CMS's processor to its own provider.
  const { spanProcessor, sampler } = cmsTracing()
  expect(traceCollector()).toBe(spanProcessor)
  expect(sampler.toString()).toContain('OtwCmsSampler')
})
