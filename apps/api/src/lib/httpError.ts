/** Throw from any handler to send `{ error, details }` with this status. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "HttpError";
  }
}

export const notFoundError = (what: string) => new HttpError(404, `${what} not found`);
export const conflictError = (message: string, details?: unknown) =>
  new HttpError(409, message, details);
