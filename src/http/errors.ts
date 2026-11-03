import type { Response } from "express";
import { logger } from "../config/logger.js";

/**
 * Errors whose message is safe to show to API clients. Anything that is not an
 * AppError (driver errors, programming bugs, unexpected library failures) is
 * logged server-side and returned as a generic message.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(400, "ValidationError", message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You do not have access to this resource.") {
    super(403, "Forbidden", message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found.") {
    super(404, "NotFound", message);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, "Conflict", message);
  }
}

const POSTGRES_ERRORS: Record<string, { status: number; message: string }> = {
  "23505": { status: 409, message: "A record with the same unique value already exists." },
  "23503": { status: 409, message: "A referenced record does not exist or is still in use." },
  "23502": { status: 400, message: "A required value is missing." },
  "23514": { status: 400, message: "One or more values violate a data rule." },
  "22P02": { status: 400, message: "One or more values have an invalid format." },
  "22001": { status: 400, message: "A value exceeds the maximum allowed length." },
  "22003": { status: 400, message: "A numeric value is out of range." },
  "22007": { status: 400, message: "A date or time value is invalid." },
  "22008": { status: 400, message: "A date or time value is out of range." },
};

function postgresErrorCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export interface PublicError {
  status: number;
  body: { error: string; code: string };
}

export function toPublicError(err: unknown): PublicError {
  if (err instanceof AppError) {
    return { status: err.status, body: { error: err.message, code: err.code } };
  }

  const pgCode = postgresErrorCode(err);
  const pgError = pgCode ? POSTGRES_ERRORS[pgCode] : undefined;
  if (pgError) {
    return {
      status: pgError.status,
      body: { error: pgError.message, code: `DB_${pgCode}` },
    };
  }

  // http-errors convention used by body-parser (malformed JSON, payload too large).
  // Parser messages can echo request fragments, so known types get fixed text.
  const httpError = err as
    | { status?: unknown; expose?: unknown; type?: unknown }
    | null;
  if (
    typeof httpError?.status === "number" &&
    httpError.status >= 400 &&
    httpError.status < 500 &&
    httpError.expose === true
  ) {
    const message =
      {
        "entity.parse.failed": "Malformed JSON request body.",
        "entity.too.large": "Request body is too large.",
        "encoding.unsupported": "Unsupported request body encoding.",
        "charset.unsupported": "Unsupported request body charset.",
      }[String(httpError.type)] ?? "The request could not be processed.";
    return {
      status: httpError.status,
      body: { error: message, code: "BadRequest" },
    };
  }

  return {
    status: 500,
    body: { error: "An unexpected error occurred.", code: "InternalServerError" },
  };
}

export function sendError(res: Response, err: unknown): void {
  const publicError = toPublicError(err);
  if (publicError.status >= 500) {
    logger.error({ err }, "[API] Unhandled error");
  } else {
    logger.warn(
      { status: publicError.status, code: publicError.body.code, err },
      "[API] Request rejected",
    );
  }
  if (res.headersSent) return;
  res.status(publicError.status).json(publicError.body);
}
