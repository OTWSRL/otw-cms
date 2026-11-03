import type { Kernel } from '@otwdesign/core'
import type { SearchParams, User } from '@otwdesign/sdk'

/** What the admin router hands a screen once the user may see it. */
export interface ScreenContext {
  kernel: Kernel
  user: User
  /** The admin path, such as `/admin/users/new`. */
  path: string
  searchParams: SearchParams
}
