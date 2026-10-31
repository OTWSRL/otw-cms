import { getKernel } from '@/cms/kernel'

/** Renders whatever active plugins put into this named slot, in priority order. */
export async function Slot({ name }: { name: string }) {
  const kernel = await getKernel()
  return kernel.slot(name).map((Fill, index) => <Fill key={`${name}:${index}`} />)
}
