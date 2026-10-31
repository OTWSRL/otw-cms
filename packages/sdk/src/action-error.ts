/**
 * Thrown from an admin action to send the user back to the form with this message. Use it for
 * problems the user can fix (a duplicate slug, a missing field); anything else is logged and
 * shown as a generic error.
 */
export class ActionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ActionError'
  }
}
