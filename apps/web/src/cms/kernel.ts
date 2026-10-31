import 'server-only'
import { createKernelHolder, type Kernel } from '@cms/core'
import { bootKernel } from './boot'
import { openDatabase, type DatabaseHandle } from './database'

// The connection lives on globalThis: PGlite allows one instance per data directory, and dev
// reloads must not open a second one. The change counter is shared the same way, so a change
// made by a route handler reaches the server-component bundle at once. The kernel itself stays
// module-scoped on purpose: Next bundles server components and route handlers separately, and
// each needs plugin components compiled for its own bundle.
const globalForCms = globalThis as typeof globalThis & {
  __cmsDatabase?: DatabaseHandle
  __cmsChanges?: number
}

const holder = createKernelHolder({
  boot: () =>
    bootKernel((globalForCms.__cmsDatabase ??= openDatabase()).db, {
      onChange: () => {
        globalForCms.__cmsChanges = (globalForCms.__cmsChanges ?? 0) + 1
      },
    }),
  localChanges: () => globalForCms.__cmsChanges ?? 0,
})

export function getKernel(): Promise<Kernel> {
  return holder.get()
}
