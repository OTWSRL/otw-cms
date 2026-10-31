/*
 * For scripts that run outside Next.js (seeding, maintenance): open the database and boot the
 * site directly. Nothing here imports Next.js or `server-only`.
 */
export { bootSite, type BootOptions } from './runtime/boot'
export { DEFAULT_DATA_DIR, dataDir, openDatabase, type DatabaseHandle } from './runtime/database'
export { activePluginsFromEnv, migrationModeFromEnv, type MigrationMode } from './runtime/settings'
