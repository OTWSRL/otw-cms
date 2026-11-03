/**
 * What the site's `instrumentation.ts` (written by `cms generate`) exports: Next.js calls it once
 * when the server starts. It installs OpenTelemetry for the CMS, which records requests only
 * while a plugin has enabled tracing.
 */
export async function register(): Promise<void> {
  // Next.js compiles this file for the Edge runtime too, with NEXT_RUNTIME inlined, so the
  // dynamic import drops out of that bundle. A static import of anything Node-only, even a
  // re-export, would land in both: cmsTracing() lives in @otwdesign/next/tracing for that reason.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { registerTracing } = await import('./runtime/tracing')
    registerTracing()
  }
}
