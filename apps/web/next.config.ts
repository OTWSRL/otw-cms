import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { NextConfig } from 'next'

// Installed plugins ship TypeScript source, so Next compiles them like app code.
const { plugins } = JSON.parse(readFileSync(resolve(process.cwd(), 'cms.config.json'), 'utf8')) as {
  plugins: string[]
}

const nextConfig: NextConfig = {
  transpilePackages: ['@cms/sdk', '@cms/core', '@cms/admin-ui', ...plugins],
  // PGlite loads its WebAssembly from its own package directory at runtime.
  serverExternalPackages: ['@electric-sql/pglite'],
  // forbidden() answers admin pages a user may not open with a real 403.
  experimental: { authInterrupts: true },
}

export default nextConfig
