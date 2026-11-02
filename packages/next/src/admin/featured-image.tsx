'use client'

import { useState } from 'react'
import { MediaPicker, previewOf, type PickedMedia } from './media-picker'

/**
 * The Featured image box's contents, as WordPress's: the image, which opens the picker to change
 * it, and Remove; or Set featured image. The choice goes in the entry's form as `thumbnail`, and
 * is saved with the rest.
 */
export function FeaturedImage({
  initial,
  entryId,
}: {
  initial: PickedMedia | null
  entryId?: string
}) {
  const [image, setImage] = useState(initial)
  const [picking, setPicking] = useState(false)

  return (
    <div className="featured-image">
      <input type="hidden" name="thumbnail" value={image?.id ?? ''} />
      {image ? (
        <>
          <button
            type="button"
            className="featured-image-preview"
            aria-label={`Change the featured image, “${image.title || image.filename}”`}
            onClick={() => setPicking(true)}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={previewOf(image)} alt={image.alt} />
          </button>
          <p className="howto description">Click the image to change it.</p>
          <button
            type="button"
            className="button-link button-link-delete"
            onClick={() => setImage(null)}
          >
            Remove featured image
          </button>
        </>
      ) : (
        <button type="button" className="button-link" onClick={() => setPicking(true)}>
          Set featured image
        </button>
      )}
      {picking && (
        <MediaPicker
          title="Featured image"
          action="Set featured image"
          entryId={entryId}
          onClose={() => setPicking(false)}
          onSelect={(item) => {
            setImage(item)
            setPicking(false)
          }}
        />
      )}
    </div>
  )
}
