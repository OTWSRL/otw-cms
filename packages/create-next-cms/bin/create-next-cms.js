#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { detectPackageManager, scaffold } from '../src/scaffold.js'

const USAGE = `Usage: create-next-cms <directory> [options]

Options:
  --plugins <list>   Plugins to install, comma-separated: commerce, commerce-stripe, or package names
  --no-install       Write the files without installing dependencies
  --link <dir>       Use the CMS packages from a checkout of the CMS instead of the registry`

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    plugins: { type: 'string', default: '' },
    'no-install': { type: 'boolean', default: false },
    link: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
})

const [target] = positionals
if (values.help || !target) {
  console.log(USAGE)
  process.exit(values.help ? 0 : 1)
}

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const packageManager = detectPackageManager()
try {
  const plugins = values.plugins
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  const { commands } = await scaffold({
    target,
    version,
    plugins,
    packageManager,
    link: values.link,
  })
  if (!values['no-install']) {
    console.log(`Installing with ${packageManager}…`)
    execFileSync(packageManager, ['install'], { cwd: target, stdio: 'inherit' })
  }
  console.log(
    `\nCreated ${target}. Next:\n\n  cd ${target}\n  ${commands.run} dev\n\nThen open http://localhost:3000/admin to set up the administrator.`,
  )
} catch (error) {
  console.error(`create-next-cms: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
