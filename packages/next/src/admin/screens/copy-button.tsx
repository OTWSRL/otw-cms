'use client'

import { useState } from 'react'

/**
 * WordPress's "Copy URL to clipboard", which says so for a moment once it has. A path is copied
 * as the full address, to paste elsewhere.
 */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null)
  return (
    <>
      <button
        type="button"
        className="button button-small"
        onClick={() => {
          navigator.clipboard.writeText(new URL(text, window.location.href).href).then(
            () => setCopied('yes'),
            // Without permission, the address stays selectable in the field beside it.
            () => setCopied('no'),
          )
          setTimeout(() => setCopied(null), 2000)
        }}
      >
        {label}
      </button>{' '}
      <span className="copy-result" role="status">
        {copied === 'yes' ? 'Copied!' : copied === 'no' ? 'Copy it from the field.' : ''}
      </span>
    </>
  )
}
