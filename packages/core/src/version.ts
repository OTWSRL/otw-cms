/**
 * Plugins target this with `requires: { core: '^1.0.0' }`. scripts/sync-core-version.mjs sets it
 * from package.json on release, and a test checks the two match.
 */
export const CORE_VERSION = '1.5.0'
