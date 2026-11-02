/**
 * Why a media call failed: the input, a file type that isn't allowed or doesn't match its
 * contents, a file over the size limit, or a missing item.
 */
export type MediaErrorCode = 'invalid_input' | 'file_type' | 'too_large' | 'not_found'

/** Thrown by `cms.media` with a `code`. Its message is safe to show the person who uploaded. */
export class MediaError extends Error {
  readonly code: MediaErrorCode

  constructor(code: MediaErrorCode, message: string) {
    super(message)
    this.name = 'MediaError'
    this.code = code
  }
}
