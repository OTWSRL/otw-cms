'use client'

import { useEffect, useState, type ComponentType } from 'react'
import type { BlockEditorProps } from './block-editor'

type Loaded = { Editor: ComponentType<BlockEditorProps> } | { failed: true } | null

/**
 * Loads the editor in a chunk of its own, in the browser only. The admin is one route, so a
 * component it imports directly would be downloaded on every admin screen; this way Tiptap is
 * fetched only where an entry is edited.
 *
 * Not with `next/dynamic`: that suspends, and React 19 holds back a suspended boundary's content
 * for 300 ms after its fallback shows, so the editor waited out a timer on every edit screen and
 * after every save. Loaded in an effect, it shows as soon as its chunk is in.
 */
export function EditorLoader(props: BlockEditorProps) {
  const [loaded, setLoaded] = useState<Loaded>(null)
  useEffect(() => {
    let current = true
    import('./block-editor').then(
      (module) => current && setLoaded({ Editor: module.BlockEditor }),
      // A deploy since the page loaded, or the network: the server still has what was saved.
      () => current && setLoaded({ failed: true }),
    )
    return () => {
      current = false
    }
  }, [])

  if (loaded && 'Editor' in loaded) return <loaded.Editor {...props} />
  return (
    <div className="block-editor is-loading" aria-busy={loaded ? undefined : true}>
      <p className="description" role={loaded ? 'alert' : undefined}>
        {loaded
          ? 'The editor couldn’t load. Reload the screen to try again; nothing has been lost.'
          : 'Loading the editor…'}
      </p>
    </div>
  )
}
