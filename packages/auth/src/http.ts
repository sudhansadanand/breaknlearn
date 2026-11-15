import { randomUUID } from "node:crypto";
import { ApiError, type ErrorCode } from "@bnl/contracts";

export const REQUEST_ID_HEADER = "X-Request-Id";

export function newRequestId(): string {
  return randomUUID();
}

export interface ApiErrorOptions {
  readonly requestId?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/** Builds (and validates) the contract error envelope. */
export function apiErrorBody(code: ErrorCode, message: string, requestId: string, details?: Record<string, unknown>): ApiError {
  return ApiError.parse({
    error: {
      code,
      message: message.slice(0, 300),
      request_id: requestId,
      ...(details === undefined ? {} : { details }),
    },
  });
}

/**
 * JSON error Response in the contract envelope with `Cache-Control: no-store`
 * and the request id echoed as a header. Messages must never carry PII.
 */
export function apiError(
  code: ErrorCode,
  message: string,
  status: number,
  details?: Record<string, unknown>,
  opts: ApiErrorOptions = {},
): Response {
  const requestId = opts.requestId ?? newRequestId();
  return new Response(JSON.stringify(apiErrorBody(code, message, requestId, details)), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      [REQUEST_ID_HEADER]: requestId,
      ...opts.headers,
    },
  });
}

/** Thrown by server logic; converted to {@link apiError} at the route boundary. */
export class HttpError extends Error {
  override readonly name = "HttpError";
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly headers?: Readonly<Record<string, string>>,
  ) {
    super(message);
  }
}
