/**
 * An error whose message is written for the person using the app.
 *
 * Parser internals throw low-level failures ("Offset is outside the bounds of
 * the DataView") that mean nothing to a user. Marking our own validation
 * failures lets the worker pass those straight through while wrapping
 * everything else in something actionable.
 */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserFacingError';
  }
}
