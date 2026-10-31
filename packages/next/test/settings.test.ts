import { describe, expect, it } from 'vitest'
import { activePluginsFromEnv, migrationModeFromEnv } from '../src/runtime/settings'

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
