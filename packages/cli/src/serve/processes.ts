import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createServer, type AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { BuiltRelease, Log, RunningRelease } from './supervisor.ts'

/** A port nothing listens on now. Another process could take it first; starting would then fail. */
export async function freePort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  server.close()
  await once(server, 'close')
  return port
}

/** Signs-in page answers (200, or a redirect to setup) once the app and its database are up. */
async function answers(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/admin/login`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(5_000),
    })
    await response.body?.cancel()
    return response.status < 500
  } catch {
    return false
  }
}

async function stopChild(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), graceMs)
  await exited
  clearTimeout(timer)
}

export interface StartOptions {
  /** Added to the supervisor's own environment. */
  env: NodeJS.ProcessEnv
  /** Where the release's output goes once it serves (the supervisor's own output). */
  output: Log
  timeoutMs?: number
  graceMs?: number
}

/**
 * Starts a release with its own `next start` on a loopback port, and resolves once it answers.
 * If it exits or doesn't answer in time, it is stopped and the promise rejects.
 */
export async function startRelease(
  release: BuiltRelease,
  log: Log,
  { env, output, timeoutMs = 60_000, graceMs = 10_000 }: StartOptions,
): Promise<RunningRelease> {
  const port = await freePort()
  const next = join(release.dir, 'node_modules', 'next', 'dist', 'bin', 'next')
  const child = spawn(
    process.execPath,
    [next, 'start', '--port', String(port), '--hostname', '127.0.0.1'],
    {
      cwd: release.dir,
      env: { ...process.env, ...env, NODE_ENV: 'production', PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let ready = false
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding('utf8')
    stream?.on('data', (chunk: string) => {
      for (const line of chunk.split('\n').filter(Boolean)) {
        const tagged = `[${release.id}] ${line}`
        if (ready) output(tagged)
        else log(tagged)
      }
    })
  }

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `The release ${release.id} exited (code ${child.exitCode}) before it answered.`,
      )
    }
    if (await answers(port)) {
      ready = true
      return { port, stop: () => stopChild(child, graceMs) }
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  await stopChild(child, graceMs)
  throw new Error(
    `The release ${release.id} did not answer within ${Math.round(timeoutMs / 1000)} seconds.`,
  )
}
