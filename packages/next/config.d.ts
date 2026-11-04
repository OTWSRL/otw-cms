import type { NextConfig } from 'next'

/** The CMS's own packages, which `withCms()` has Next.js compile from source. */
export declare const CORE_PACKAGES: readonly string[]

/**
 * The Next.js settings a CMS site needs, merged into the site's own. With `CMS_STANDALONE=1`, as
 * the site's Dockerfile builds, Next.js writes a standalone server: only the files the site runs
 * on, for a small image.
 */
export declare function withCms(
  nextConfig?: NextConfig,
  options?: { config?: string; env?: Record<string, string | undefined> },
): NextConfig
