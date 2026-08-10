/**
 * Error types shared across the target layer.
 *
 * `name` is part of the messaging wire format: errors crossing the
 * service-worker boundary are flattened to plain objects and reconstructed by
 * name on the other side, so these strings must stay stable.
 */

export class NetworkError extends Error {
  override readonly name: string = 'NetworkError';
  override readonly cause: unknown;

  constructor(cause?: unknown, message?: string) {
    super(message ?? 'Network request failed');
    this.cause = cause;
  }
}

export class HttpError extends NetworkError {
  override readonly name: string = 'HttpError';
  readonly statusCode: number | undefined;

  constructor(cause?: unknown, message?: string) {
    super(cause, message);
    this.statusCode = (cause as { statusCode?: number } | undefined)?.statusCode;
  }
}

export class HttpNotFoundError extends HttpError {
  override readonly name: string = 'HttpNotFoundError';
}

export class HttpServerError extends HttpError {
  override readonly name: string = 'HttpServerError';
}

export class ContentTypeRejectedError extends Error {
  override readonly name: string = 'ContentTypeRejectedError';
}

export class ProfileNotExistError extends Error {
  override readonly name: string = 'ProfileNotExistError';
  readonly profileName: string;

  constructor(profileName: string) {
    super(`Profile ${profileName} does not exist!`);
    this.profileName = profileName;
  }
}

export class NoOptionsError extends Error {
  override readonly name: string = 'NoOptionsError';
}
