/* The CLI's pieces, for scripts and for create-next-cms. */
export { generate, managedFiles, MARKER, parseConfig, siteModulePath } from './generate.ts'
export type { CmsConfig, FileStatus, GenerateResult, ManagedFile, SiteLayout } from './generate.ts'
export { migrate, type MigrateOptions, type MigrateResult } from './migrate.ts'
export { loadEnv, loadSite } from './site.ts'
export {
  CORE_PACKAGES,
  detectPackageManager,
  nextSpec,
  planSite,
  planUpdate,
  readSitePackages,
  npmView,
  resolveTargets,
  writeChanges,
  type Packument,
  type PluginReport,
  type SitePackages,
  type Unreachable,
  type UpdatePlan,
  type UpdateScope,
} from './update.ts'
