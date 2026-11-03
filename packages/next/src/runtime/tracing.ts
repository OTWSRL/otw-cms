import type { Sampler, SpanProcessor } from '@opentelemetry/sdk-trace'
import { registerTracerProvider, TraceCollector } from '@otwdesign/core'

// One per process, shared by every bundle: Next.js compiles route handlers and pages separately.
const globalForTraces = globalThis as typeof globalThis & { __otwTraces?: TraceCollector }

/** The process's trace collector, once the site's instrumentation has registered it. */
export function traceCollector(): TraceCollector | undefined {
  return globalForTraces.__otwTraces
}

/**
 * Installs an OpenTelemetry tracer provider whose sampler and processor are the CMS's collector.
 * A site that sets up OpenTelemetry itself keeps its own; CMS tracing then stays off.
 */
export function registerTracing(): TraceCollector | undefined {
  if (globalForTraces.__otwTraces) return globalForTraces.__otwTraces
  const collector = new TraceCollector()
  // Registration is first come, first served.
  if (!registerTracerProvider(collector)) {
    console.warn(
      "cms: the site sets up OpenTelemetry itself, so CMS tracing is off. Add cmsTracing()'s span processor from @otwdesign/next/tracing to your tracer provider to turn it on.",
    )
    return undefined
  }
  globalForTraces.__otwTraces = collector
  return collector
}

/**
 * For a site that sets up OpenTelemetry itself: the CMS's span processor, to add to its tracer
 * provider, and its sampler, which records only while a plugin has enabled tracing. Use the
 * sampler too, or keep yours to record (and export) every request.
 */
export function cmsTracing(): { spanProcessor: SpanProcessor; sampler: Sampler } {
  globalForTraces.__otwTraces ??= new TraceCollector()
  const collector = globalForTraces.__otwTraces
  return { spanProcessor: collector, sampler: collector.sampler }
}
