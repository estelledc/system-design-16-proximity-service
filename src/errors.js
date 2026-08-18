export class AppError extends Error {
  constructor(code, status, message, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const invalid = (message) => new AppError('invalid_request', 400, message);
export const unauthorized = () => new AppError('unauthorized', 401, 'valid bearer authentication is required');
export const notFound = () => new AppError('not_found', 404, 'resource not found');
export const gone = (message = 'resource is no longer available') => new AppError('gone', 410, message);
export const conflict = (message) => new AppError('intent_conflict', 409, message);
export const precondition = (etag) => new AppError(
  'precondition_failed',
  412,
  'the supplied place version is stale',
  { etag },
);
export const densityLimit = () => new AppError(
  'density_limit_exceeded',
  422,
  'the exact result set exceeds the materialization limit',
);

export function asAppError(error) {
  return error instanceof AppError
    ? error
    : new AppError('internal_error', 500, 'internal server error');
}
