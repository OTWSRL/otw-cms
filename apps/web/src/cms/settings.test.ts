import { describe, expect, it } from 'vitest'
import { activePluginsFromEnv } from './settings'

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
