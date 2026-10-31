import { describe, expect, it } from 'vitest'
import { CapabilityStore } from '../src/capabilities'

declare module '@cms/sdk' {
  interface Capabilities {
    'shop.manage_orders': true
    'lms.manage_courses': true
  }
}

const user = (role: string) => ({ id: '1', email: 'a@b.co', name: '', role })

function store() {
  let sealed = false
  const capabilities = new CapabilityStore((what) => {
    if (sealed) throw new Error(`late ${what}`)
  })
  capabilities.role('core', 'administrator', { label: 'Administrator' })
  return {
    capabilities,
    seal: () => {
      capabilities.seal()
      sealed = true
    },
  }
}

describe('CapabilityStore', () => {
  it('gives administrators every capability and nobody anything when signed out', () => {
    const { capabilities, seal } = store()
    seal()
    expect(capabilities.can(user('administrator'), 'anything.at_all')).toBe(true)
    expect(capabilities.can(null, 'anything.at_all')).toBe(false)
  })

  it('grants a role its own capabilities and those other plugins grant to it', () => {
    const { capabilities, seal } = store()
    capabilities.capability('shop', 'shop.manage_orders', { label: 'Orders' })
    capabilities.role('shop', 'shop_manager', {
      label: 'Shop manager',
      capabilities: ['shop.manage_orders'],
    })
    // The LMS loads after the shop and lets shop managers sell courses too.
    capabilities.capability('lms', 'lms.manage_courses', {
      label: 'Courses',
      roles: ['shop_manager'],
    })
    seal()

    expect(capabilities.can(user('shop_manager'), 'shop.manage_orders')).toBe(true)
    expect(capabilities.can(user('shop_manager'), 'lms.manage_courses')).toBe(true)
    expect(capabilities.can(user('shop_manager'), 'core.manage_plugins')).toBe(false)
    expect(capabilities.can(user('deleted_role'), 'shop.manage_orders')).toBe(false)
  })

  it('drops grants to roles no active plugin defines', () => {
    const { capabilities, seal } = store()
    capabilities.capability('lms', 'lms.manage_courses', { label: 'Courses', roles: ['teacher'] })
    seal()
    expect(capabilities.hasRole('teacher')).toBe(false)
    expect(capabilities.can(user('teacher'), 'lms.manage_courses')).toBe(false)
  })

  it('enforces namespacing, unique names and registration during setup', () => {
    const { capabilities, seal } = store()
    expect(() => capabilities.capability('lms', 'shop.refund', { label: 'X' })).toThrow(
      'Capability "shop.refund" must start with "lms."',
    )
    expect(() => capabilities.role('lms', 'Teacher', { label: 'X' })).toThrow('Invalid role id')
    expect(() => capabilities.role('lms', 'administrator', { label: 'X' })).toThrow(
      'Role "administrator" is already defined by plugin "core"',
    )
    capabilities.capability('lms', 'lms.teach', { label: 'Teach' })
    expect(() => capabilities.capability('lms', 'lms.teach', { label: 'Teach' })).toThrow(
      'already defined',
    )
    seal()
    expect(() => capabilities.role('lms', 'teacher', { label: 'Teacher' })).toThrow('late role')
  })
})
