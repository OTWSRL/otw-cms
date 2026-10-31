#!/usr/bin/env node
// Plain JavaScript, so it runs from node_modules: it registers tsx, which then loads the CLI, the
// CMS packages and the site's plugins from their TypeScript source.
import { register } from 'tsx/esm/api'

register()
await import('../src/main.ts')
