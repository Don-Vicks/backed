// An error whose message is written for the person who caused it. API routes answer with `status`
// and show the message as is; any other error becomes a generic 500 with a request id.
export type HttpErrorStatus = 400 | 403 | 404 | 409 | 413 | 422 | 429 | 503

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: HttpErrorStatus = 400,
  ) {
    super(message)
  }
}

// A swap the request or the curve cannot take. Routes answer with `status`:
// 400 for bad input, 404 for an unknown pool, 409 when the pool's state rules it out (goal reached).
export class SwapError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message)
  }
}
