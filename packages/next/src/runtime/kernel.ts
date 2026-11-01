import 'server-only'
import { createKernelHolder, type Kernel, type KernelHolder } from '@otw/core'
import { currentSite, type Site } from '../site-registry'
import { bootSite } from './boot'
import { openDatabase, type DatabaseHandle } from './database'

// The connection lives on globalThis: PGlite allows one instance per data directory, and dev
// reloads must not open a second one. The change counter is shared the same way, so a change
// made by a route handler reaches the server-component bundle at once. Kernels stay per bundle
// (see site-registry.ts).
const globalForCms = globalThis as typeof globalThis & {
  __cmsDatabase?: DatabaseHandle
  __cmsChanges?: number
}

// Keyed by site, so a dev reload that regenerates the site module boots the new plugin list.
const holders = new WeakMap<Site, KernelHolder>()

function holderFor(site: Site): KernelHolder {
  let holder = holders.get(site)
  if (!holder) {
    holder = createKernelHolder({
      boot: () =>
        bootSite(site, (globalForCms.__cmsDatabase ??= openDatabase()).db, {
          onChange: () => {
            globalForCms.__cmsChanges = (globalForCms.__cmsChanges ?? 0) + 1
          },
        }),
      localChanges: () => globalForCms.__cmsChanges ?? 0,
    })
    holders.set(site, holder)
  }
  return holder
}

export function getKernel(): Promise<Kernel> {
  return holderFor(currentSite()).get()
}
