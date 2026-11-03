// Runs after `changeset version`: CORE_VERSION, which plugins' `requires.core` is checked against,
// follows @otwdesign/core's package.json. Core's CORE_VERSION test fails if the two ever differ.
import { readFileSync, writeFileSync } from 'node:fs'

const core = new URL('../packages/core/', import.meta.url)
const { version } = JSON.parse(readFileSync(new URL('package.json', core), 'utf8'))
const file = new URL('src/version.ts', core)
const source = readFileSync(file, 'utf8')
const line = /export const CORE_VERSION = '[^']*'/
if (!line.test(source)) throw new Error(`${file.pathname} has no CORE_VERSION line to update`)
writeFileSync(file, source.replace(line, `export const CORE_VERSION = '${version}'`))
console.log(`CORE_VERSION is ${version}`)
