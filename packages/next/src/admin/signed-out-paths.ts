/**
 * The admin's screens for people who aren't signed in: sign-in, its second step, and setup. They
 * have wp-login.php's frame, never the admin's. Written out here, not imported from core, because
 * the admin frame reads them in the browser; a test checks they match core's.
 */
export const SIGNED_OUT_PATHS: readonly string[] = [
  '/admin/login',
  '/admin/login/verify',
  '/admin/setup',
]

export function isSignedOutPath(pathname: string): boolean {
  return SIGNED_OUT_PATHS.includes(pathname)
}
