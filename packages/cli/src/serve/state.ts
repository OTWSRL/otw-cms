import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ServeState } from './supervisor.ts'

const EMPTY: ServeState = { current: null, releases: [], autoUpdate: 'off', lastCheck: null }

export async function loadState(file: string): Promise<ServeState> {
  const raw = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  return raw ? { ...EMPTY, ...(JSON.parse(raw) as Partial<ServeState>) } : structuredClone(EMPTY)
}

/** Written beside and renamed over, so a crash mid-write never leaves half a file. */
export async function saveState(file: string, state: ServeState): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`)
  await rename(temporary, file)
}

const BACKUPS_KEPT = 3

/** The embedded database's directory, copied while no release holds it. */
export async function backupDatabase(
  dataDir: string,
  backupsDir: string,
  now: Date,
): Promise<string> {
  const target = join(backupsDir, `pglite-${now.toISOString().replace(/[:.]/g, '-')}`)
  await cp(dataDir, target, { recursive: true, errorOnExist: true, force: false })
  const all = (await readdir(backupsDir)).filter((name) => name.startsWith('pglite-')).sort()
  for (const old of all.slice(0, Math.max(0, all.length - BACKUPS_KEPT))) {
    await rm(join(backupsDir, old), { recursive: true, force: true })
  }
  return target
}

export async function restoreDatabase(backup: string, dataDir: string): Promise<void> {
  await rm(dataDir, { recursive: true, force: true })
  await cp(backup, dataDir, { recursive: true })
}
