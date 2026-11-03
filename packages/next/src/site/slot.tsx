import type { SlotComponent, SlotName, Slots } from '@otwdesign/sdk'
import { getKernel } from '../runtime/kernel'

type SlotProps<K extends SlotName> = { name: K } & (Slots[K] extends Record<string, never>
  ? { props?: Slots[K] }
  : { props: Slots[K] })

/** Renders whatever active plugins put into this named slot, in priority order. */
export async function Slot<K extends SlotName>({ name, props }: SlotProps<K>) {
  const kernel = await getKernel()
  return kernel.slot(name).map((component, index) => {
    // Generic over K, so JSX can't check the props; SlotProps already did.
    const Fill = component as SlotComponent<SlotName> as (
      props: object,
    ) => ReturnType<SlotComponent>
    return <Fill key={`${name}:${index}`} {...(props ?? {})} />
  })
}
