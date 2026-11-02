import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { activePluginsFromEnv, migrationModeFromEnv, uploadsFromEnv } from '../src/runtime/settings'

describe('activePluginsFromEnv', () => {
  it('leaves activation to the database when unset or blank', () => {
    expect(activePluginsFromEnv({})).toBeUndefined()
    expect(activePluginsFromEnv({ CMS_ACTIVE_PLUGINS: '  ' })).toBeUndefined()
  })

  it('parses a comma-separated list', () => {
    expect(activePluginsFromEnv({ CMS_ACTIVE_PLUGINS: 'commerce, commerce-stripe,,' })).toEqual([
      'commerce',
      'commerce-stripe',
    ])
  })
})

describe('migrationModeFromEnv', () => {
  it('migrates at startup unless told the deploy does it', () => {
    expect(migrationModeFromEnv({})).toBe('startup')
    expect(migrationModeFromEnv({ CMS_MIGRATIONS: ' ' })).toBe('startup')
    expect(migrationModeFromEnv({ CMS_MIGRATIONS: 'deploy' })).toBe('deploy')
  })

  it('refuses a value it doesn’t know, rather than guessing', () => {
    expect(() => migrationModeFromEnv({ CMS_MIGRATIONS: 'never' })).toThrow(
      'CMS_MIGRATIONS must be "startup" or "deploy", not "never"',
    )
  })
})

describe('uploadsFromEnv', () => {
  it('keeps uploads in .data/uploads, up to 64 MB each, unless told otherwise', () => {
    expect(uploadsFromEnv({})).toEqual({
      dir: resolve('.data/uploads'),
      maxBytes: 64 * 1024 * 1024,
    })
    expect(uploadsFromEnv({ CMS_UPLOADS_DIR: '/srv/uploads', CMS_MAX_UPLOAD_MB: '0.5' })).toEqual({
      dir: '/srv/uploads',
      maxBytes: 512 * 1024,
    })
  })

  it('refuses a limit that isn’t a size', () => {
    for (const value of ['0', '-1', '64MB', '20000']) {
      expect(() => uploadsFromEnv({ CMS_MAX_UPLOAD_MB: value })).toThrow('CMS_MAX_UPLOAD_MB')
    }
  })
})
