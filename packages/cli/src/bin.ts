#!/usr/bin/env node
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { generate } from './generate.ts'

const USAGE = 'Usage: cms generate [--config cms.config.json] [--out src/cms/plugins.generated.ts]'

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: 'string', default: 'cms.config.json' },
    out: { type: 'string', default: 'src/cms/plugins.generated.ts' },
  },
})

if (positionals[0] !== 'generate') {
  console.error(USAGE)
  process.exit(1)
}

try {
  const out = resolve(values.out)
  const { changed } = await generate({ config: resolve(values.config), out })
  console.log(changed ? `cms: wrote ${out}` : 'cms: plugin map up to date')
} catch (error) {
  console.error(`cms: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
