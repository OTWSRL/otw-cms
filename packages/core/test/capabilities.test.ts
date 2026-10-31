import { describe, expect, it } from 'vitest'
import { CapabilityStore } from '../src/capabilities'

declare module '@cms/sdk' {
  interface Capabilities {
    'shop.manage_orders': true
    'shop.refund_orders': true
    'lms.manage_courses': true
    'lms.edit_courses': true
    'lms.edit_others_courses': true
  }
  interface MetaCapabilities {
    'lms.edit_course': [course: Course]
  }
}

interface Course {
  authorId: string
  archived: boolean
}

const user = (role: string, id = '1') => ({ id, email: 'a@b.co', name: '', role })

function store() {
  let sealed = false
  const errors: string[] = []
  const capabilities = new CapabilityStore(
    (what) => {
      if (sealed) throw new Error(`late ${what}`)
    },
    (capability, pluginId, error) => errors.push(`${capability} ${pluginId} ${String(error)}`),
  )
  capabilities.role('core', 'administrator', { label: 'Administrator' })
  return {
    capabilities,
    errors,
    seal: () => {
      capabilities.seal()
      sealed = true
    },
  }
}

/** WordPress's `edit_post` mapping, for courses. */
function defineCourses(capabilities: CapabilityStore) {
  capabilities.capability('lms', 'lms.edit_courses', { label: 'Edit courses' })
  capabilities.capability('lms', 'lms.edit_others_courses', { label: "Edit others' courses" })
  capabilities.role('lms', 'instructor', {
    label: 'Instructor',
    capabilities: ['lms.edit_courses'],
  })
  capabilities.metaCapability('lms', 'lms.edit_course', {
    label: 'Edit a course',
    map: (user, ...args) => {
      const course = args[0] as Course
      if (course.archived) return false
      return course.authorId === user.id
        ? ['lms.edit_courses']
        : ['lms.edit_courses', 'lms.edit_others_courses']
    },
  })
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

  it('lets any plugin grant and revoke capabilities on any role, revokes last', () => {
    const { capabilities, seal } = store()
    capabilities.capability('shop', 'shop.manage_orders', { label: 'Orders' })
    capabilities.capability('shop', 'shop.refund_orders', { label: 'Refunds' })
    capabilities.role('shop', 'shop_manager', {
      label: 'Shop manager',
      capabilities: ['shop.manage_orders', 'shop.refund_orders'],
    })
    // A third plugin tightens the shop's role and lends it the LMS's capability.
    capabilities.revoke('policy', 'shop_manager', ['shop.refund_orders'])
    capabilities.grant('policy', 'shop_manager', ['lms.manage_courses', 'shop.refund_orders'])
    capabilities.grant('policy', 'teacher', ['shop.manage_orders'])
    seal()

    const manager = user('shop_manager')
    expect(capabilities.can(manager, 'shop.manage_orders')).toBe(true)
    expect(capabilities.can(manager, 'lms.manage_courses')).toBe(true)
    expect(capabilities.can(manager, 'shop.refund_orders')).toBe(false)
    expect(capabilities.hasRole('teacher')).toBe(false)
    expect(capabilities.roles().find((role) => role.id === 'shop_manager')).toEqual({
      id: 'shop_manager',
      label: 'Shop manager',
      capabilities: ['shop.manage_orders'],
    })
  })

  it('refuses to change administrators, who always have everything', () => {
    const { capabilities } = store()
    expect(() => capabilities.revoke('lms', 'administrator', ['core.manage_plugins'])).toThrow(
      'Administrators always have every capability',
    )
    expect(() => capabilities.grant('lms', 'administrator', ['core.manage_plugins'])).toThrow(
      'Administrators always have every capability',
    )
  })

  it('maps meta capabilities to the primitive ones the object requires', () => {
    const { capabilities, seal } = store()
    defineCourses(capabilities)
    capabilities.role('lms', 'editor', {
      label: 'Editor',
      capabilities: ['lms.edit_courses', 'lms.edit_others_courses'],
    })
    seal()

    const own = { authorId: '7', archived: false }
    const others = { authorId: '8', archived: false }
    const instructor = user('instructor', '7')
    expect(capabilities.can(instructor, 'lms.edit_course', own)).toBe(true)
    expect(capabilities.can(instructor, 'lms.edit_course', others)).toBe(false)
    expect(capabilities.can(user('editor'), 'lms.edit_course', others)).toBe(true)
    expect(capabilities.can(user('administrator'), 'lms.edit_course', others)).toBe(true)
    expect(capabilities.can(null, 'lms.edit_course', own)).toBe(false)
  })

  it('denies everyone, administrators included, when the map returns false', () => {
    const { capabilities, seal } = store()
    defineCourses(capabilities)
    seal()
    const archived = { authorId: '7', archived: true }
    expect(capabilities.can(user('administrator'), 'lms.edit_course', archived)).toBe(false)
    expect(capabilities.can(user('instructor', '7'), 'lms.edit_course', archived)).toBe(false)
  })

  it('runs extensions from other plugins after the map, in load order', () => {
    const { capabilities, seal } = store()
    defineCourses(capabilities)
    capabilities.capability('shop', 'shop.manage_orders', { label: 'Orders' })
    capabilities.role('shop', 'shop_manager', {
      label: 'Shop manager',
      capabilities: ['shop.manage_orders'],
    })
    // Shop managers may edit any course; a later plugin then locks archived ones for good.
    capabilities.extendCapability('shop', 'lms.edit_course', (required) =>
      required === false ? required : ['shop.manage_orders'],
    )
    capabilities.extendCapability('archive', 'lms.edit_course', (required, _user, ...args) =>
      (args[0] as Course).archived ? false : required,
    )
    // Extending a meta capability whose plugin is inactive does nothing.
    capabilities.extendCapability('shop', 'forum.moderate', () => false)
    seal()

    const manager = user('shop_manager')
    expect(capabilities.can(manager, 'lms.edit_course', { authorId: '7', archived: false })).toBe(
      true,
    )
    expect(capabilities.can(manager, 'lms.edit_course', { authorId: '7', archived: true })).toBe(
      false,
    )
  })

  it('denies and reports when a map or an extension throws', () => {
    const { capabilities, errors, seal } = store()
    defineCourses(capabilities)
    capabilities.extendCapability('buggy', 'lms.edit_course', () => {
      throw new Error('boom')
    })
    seal()
    expect(capabilities.can(user('administrator'), 'lms.edit_course', { authorId: '1' })).toBe(
      false,
    )
    expect(errors).toEqual(['lms.edit_course buggy Error: boom'])
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
    expect(() =>
      capabilities.metaCapability('lms', 'lms.teach', { label: 'Teach', map: () => false }),
    ).toThrow('Capability "lms.teach" is already defined by plugin "lms"')
    expect(() =>
      capabilities.metaCapability('lms', 'shop.refund', { label: 'X', map: () => false }),
    ).toThrow('must start with "lms."')
    seal()
    expect(() => capabilities.role('lms', 'teacher', { label: 'Teacher' })).toThrow('late role')
  })
})
