/**
 * Thrown from an admin page loader, admin action or API route when the user may not act on this
 * particular object, such as a meta capability check that needs the loaded record. Answers 403.
 */
export class ForbiddenError extends Error {
  constructor(message = 'You are not allowed to do that') {
    super(message)
    this.name = 'ForbiddenError'
  }
}
