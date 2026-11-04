/** Typed HTTP errors. One shape in, one shape out. */

export class ApiError extends Error {
  status: number;
  code: string;
  detail: unknown;

  constructor(status: number, code: string, message: string, detail: unknown = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }

  toJSON() {
    return { error: this.code, message: this.message, ...(this.detail ? { detail: this.detail } : {}) };
  }
}

export const badRequest = (message: string, detail?: unknown) =>
  new ApiError(400, "bad_request", message, detail);
export const unauthorized = (message = "A bearer token is required for this endpoint.") =>
  new ApiError(401, "unauthorized", message);
export const forbidden = (message: string) => new ApiError(403, "forbidden", message);
export const notFound = (message = "Not found.") => new ApiError(404, "not_found", message);
export const conflict = (message: string) => new ApiError(409, "conflict", message);
export const tooMany = (message: string) => new ApiError(429, "rate_limited", message);
export const notImplemented = (message: string) => new ApiError(501, "not_implemented", message);
export const unavailable = (message: string) => new ApiError(503, "unavailable", message);
