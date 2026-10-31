import type { NextConfig } from 'next'

export declare const CORE_PACKAGES: readonly string[]

/** The Next.js settings a CMS site needs, merged into the site's own. */
export declare function withCms(nextConfig?: NextConfig, options?: { config?: string }): NextConfig
