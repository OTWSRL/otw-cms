import { execFile } from 'node:child_process'
import { join, relative, resolve } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { consoleLogger } from '@cms/core'
import { migrationModeFromEnv } from '@cms/next/server'
import { displayPath, generate } from './generate.ts'
import { migrate } from './migrate.ts'
import { serve } from './serve/index.ts'
import { loadEnv, loadSite } from './site.ts'
import {
  commitUpdate,
  detectPackageManager,
  install,
  planSite,
  writeChanges,
  type UpdatePlan,
} from './update.ts'

const USAGE = `Usage: cms <command> [options]

Commands:
  generate   Write the site module and the CMS's route files from cms.config.json
  migrate    Back up the database, then run pending migrations
               --dry-run     list them and change nothing
               --no-backup   when your host takes backups (most managed Postgres does)
  serve      Run the site from built releases, with updates from the admin (instead of next start)
               --port <n>       public port (default: PORT, or 3000)
               --hostname <h>   address to listen on (default: 0.0.0.0)
               --no-backup      with Postgres, when your host takes backups
  update [packages...]
             Update core and plugins to the newest compatible versions; name plugins (or
             "core") to update only those
               --check          report what would change, and change nothing
               --plugins-only   leave core where it is
               --major          allow a new major version of core
               --force          update even if a plugin would be switched off
               --commit         put the update on a new git branch, for hosts that build from git

Options:
  --root <dir>   The site's directory (default: the current directory)`

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    root: { type: 'string', default: '.' },
    help: { type: 'boolean', short: 'h' },
    'dry-run': { type: 'boolean', default: false },
    'no-backup': { type: 'boolean', default: false },
    check: { type: 'boolean', default: false },
    major: { type: 'boolean', default: false },
    'plugins-only': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    commit: { type: 'boolean', default: false },
    port: { type: 'string' },
    hostname: { type: 'string', default: '0.0.0.0' },
  },
})

const run = promisify(execFile)

async function runGenerate(root: string): Promise<void> {
  const { files } = await generate({ root })
  for (const { path, status } of files) {
    if (status === 'written') console.log(`cms: wrote ${displayPath(root, path)}`)
    if (status === 'kept') {
      console.warn(
        `cms: kept ${displayPath(root, path)}: it has no "@generated" line, so it is yours. Compare it with a new site from create-next-cms after updating.`,
      )
    }
  }
  if (files.every(({ status }) => status === 'unchanged')) console.log('cms: up to date')
}

async function runMigrate(root: string): Promise<void> {
  const env = loadEnv(root)
  const site = await loadSite(root)
  const result = await migrate({
    root,
    env,
    site,
    logger: { ...consoleLogger, info: () => {} },
    dryRun: values['dry-run'],
    backup: !values['no-backup'],
  })
  if ('pending' in result) {
    console.log(
      result.pending.length === 0
        ? 'cms: no pending migrations'
        : `cms: pending migrations:\n${result.pending.map((key) => `  ${key}`).join('\n')}`,
    )
    return
  }
  if (result.backup) {
    console.log(
      `cms: backed up the database to ${displayPath(root, relative(root, result.backup))}`,
    )
  }
  console.log(
    result.applied.length === 0
      ? 'cms: the database is up to date'
      : `cms: applied ${result.applied.length} migration(s):\n${result.applied.map((key) => `  ${key}`).join('\n')}`,
  )
}

const COMPATIBILITY: Record<UpdatePlan['plugins'][number]['compatible'], string> = {
  yes: 'works with this core',
  unknown: 'compatibility unknown: it does not say which core it supports',
  no: 'does not support this core',
}

function report(plan: UpdatePlan): void {
  console.log(
    plan.core ? `Next CMS ${plan.core.from} → ${plan.core.to}` : 'Next CMS stays where it is',
  )
  if (plan.plugins.length > 0) {
    console.log('Plugins:')
    for (const plugin of plan.plugins) {
      const versions = plugin.to ? `${plugin.from} → ${plugin.to}` : plugin.from
      console.log(`  ${plugin.name} ${versions}: ${COMPATIBILITY[plugin.compatible]}`)
      if (plugin.note) console.log(`    ${plugin.latest} is out, but ${plugin.note}`)
    }
  }
  if (plan.linked.length > 0) {
    console.log(`Linked, so updated with your workspace instead: ${plan.linked.join(', ')}`)
  }
  for (const warning of plan.warnings) console.warn(`cms: ${warning}`)
  for (const blocker of plan.blockers) console.warn(`cms: ${blocker}`)
}

/** Runs the newly installed CLI, so its route files and migrations are the new version's. */
async function runInstalledCli(root: string, args: string[]): Promise<void> {
  const bin = join(root, 'node_modules', '@cms', 'cli', 'bin', 'cms.js')
  const { stdout } = await run(process.execPath, [bin, ...args, '--root', root], { cwd: root })
  process.stdout.write(stdout)
}

async function runUpdate(root: string, names: readonly string[]): Promise<void> {
  const plan = await planSite(root, {
    major: values.major,
    pluginsOnly: values['plugins-only'],
    packages: names,
  })
  report(plan)
  if (values.check) return
  if (plan.changes.length === 0) {
    console.log('cms: nothing to update')
    return
  }
  if (plan.blockers.length > 0 && !values.force) {
    throw new Error('Not updating; see above. Run with --force to update anyway.')
  }
  if (values.commit) {
    const { stdout } = await run('git', ['status', '--porcelain'], { cwd: root })
    if (stdout.trim())
      throw new Error('Commit or stash your changes first, so the update is a commit of its own')
  }

  await writeChanges(root, plan.changes)
  const manager = await detectPackageManager(root)
  console.log(`cms: installing with ${manager}`)
  await install(root, manager)
  await runInstalledCli(root, ['generate'])

  const target = plan.core?.to
  if (values.commit) {
    const branch = `cms-update-${target ?? 'plugins'}-${Date.now().toString(36)}`
    const message = target ? `Update Next CMS to ${target}` : 'Update Next CMS plugins'
    await commitUpdate(root, branch, message)
    console.log(
      `cms: committed on ${branch}. Push it and open a pull request; your host builds it, and runs \`cms migrate\` if you deploy with CMS_MIGRATIONS=deploy.`,
    )
    return
  }
  const env = loadEnv(root)
  console.log(
    migrationModeFromEnv(env) === 'deploy'
      ? `cms: updated. Run \`cms migrate\` when you deploy, then \`${manager} run build\` and restart.`
      : `cms: updated. Stop the site, run \`cms migrate\` (it backs up first), then \`${manager} run build\` and start it again. Without cms migrate, migrations run when the site starts, with no backup.`,
  )
}

async function main(): Promise<void> {
  const [command] = positionals
  if (values.help || !command) {
    console.log(USAGE)
    return
  }
  const root = resolve(values.root)
  // Relative paths in the environment (CMS_DATA_DIR) mean the site's directory, as under Next.js.
  process.chdir(root)
  if (command === 'generate') return runGenerate(root)
  if (command === 'migrate') return runMigrate(root)
  if (command === 'update') return runUpdate(root, positionals.slice(1))
  if (command === 'serve') {
    const port = Number(values.port ?? process.env.PORT ?? 3000)
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new Error('--port must be a port number')
    return serve({
      root,
      port,
      hostname: values.hostname,
      backup: !values['no-backup'],
      // For tests; twelve hours otherwise, as WordPress checks twice a day.
      checkEveryMs: Number(process.env.CMS_UPDATE_CHECK_EVERY_MS) || undefined,
    })
  }
  throw new Error(`Unknown command "${command}"\n\n${USAGE}`)
}

main().catch((error: unknown) => {
  console.error(`cms: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
