/** Why a content call failed: the input, a type no active plugin registers, or a missing entry. */
export type ContentErrorCode = 'invalid_input' | 'unknown_type' | 'not_found'

/** Thrown by `cms.content` with a `code`. Its message is safe to show the person who sent the input. */
export class ContentError extends Error {
  readonly code: ContentErrorCode

  constructor(code: ContentErrorCode, message: string) {
    super(message)
    this.name = 'ContentError'
    this.code = code
  }
}
