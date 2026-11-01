/*
 * For a site that sets up OpenTelemetry itself. Node.js only: import it from a file that the
 * site's instrumentation.ts loads on the Node.js runtime, never from instrumentation.ts itself.
 */
export { cmsTracing } from './runtime/tracing'
