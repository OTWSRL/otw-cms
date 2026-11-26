import { ADMIN_VERIFY_PATH, LOGIN_PATH } from '@otwdesign/core'
import { describe, expect, it } from 'vitest'
import { isSignedOutPath, SIGNED_OUT_PATHS } from '../src/admin/signed-out-paths'

describe('the admin’s signed-out screens', () => {
  it('are core’s sign-in, its second step and setup, as the browser’s copy says', () => {
    expect(SIGNED_OUT_PATHS).toEqual([LOGIN_PATH, ADMIN_VERIFY_PATH, '/admin/setup'])
  })

  it('are those paths exactly: the frame stays for anything under or beside them', () => {
    expect(isSignedOutPath('/admin/login')).toBe(true)
    for (const path of ['/admin', '/admin/login/', '/admin/loginx', '/admin/setup/more', '/']) {
      expect({ path, signedOut: isSignedOutPath(path) }).toEqual({ path, signedOut: false })
    }
  })
})
