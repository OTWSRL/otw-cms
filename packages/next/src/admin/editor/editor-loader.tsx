'use client'

import dynamic from 'next/dynamic'
import type { BlockEditorProps } from './block-editor'

/**
 * Loads the editor in a chunk of its own, in the browser only. The admin is one route, so a
 * component it imports directly would be downloaded on every admin screen; this way Tiptap is
 * fetched only where an entry is edited.
 */
const BlockEditor = dynamic(() => import('./block-editor').then((module) => module.BlockEditor), {
  ssr: false,
  loading: () => (
    <div className="block-editor is-loading" aria-busy="true">
      <p className="description">Loading the editor…</p>
    </div>
  ),
})

export function EditorLoader(props: BlockEditorProps) {
  return <BlockEditor {...props} />
}
