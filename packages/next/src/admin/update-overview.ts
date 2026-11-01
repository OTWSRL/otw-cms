import type { Kernel, UpdateOverview } from '@otw/core'
import type { User } from '@otw/sdk'
import { cache } from 'react'

const overviewOnce = cache(
  async (kernel: Kernel): Promise<UpdateOverview | null> =>
    (await kernel.updates?.overview()) ?? null,
)

/**
 * What the update service says, asked once per request however many parts of the screen need it,
 * and only for people who may update.
 */
export async function updateOverview(kernel: Kernel, user: User): Promise<UpdateOverview | null> {
  return kernel.can(user, 'core.manage_updates') ? overviewOnce(kernel) : null
}
