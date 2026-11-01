import type { NextConfig } from 'next'

/** The CMS's own packages, which `withCms()` has Next.js compile from source. */
export declare const CORE_PACKAGES: readonly string[]

/** The Next.js settings a CMS site needs, merged into the site's own. */
export declare function withCms(nextConfig?: NextConfig, options?: { config?: string }): NextConfig
