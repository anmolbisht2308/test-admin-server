import type { ApiError } from "@mockprep/types";
import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { HttpError } from "../lib/httpError.js";

export const notFound: RequestHandler = (req, res) => {
  const body: ApiError = { error: `Not found: ${req.method} ${req.path}` };
  res.status(404).json(body);
};

/** The single error middleware. Always responds `{ error, details? }`. */
export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, _next) => {
  let status = 500;
  let body: ApiError = { error: "Internal server error" };

  if (err instanceof HttpError) {
    status = err.status;
    body = { error: err.message, ...(err.details === undefined ? {} : { details: err.details }) };
  } else if (err instanceof ZodError) {
    status = 400;
    body = { error: "Validation failed", details: err.issues };
  } else if (isDuplicateKeyError(err)) {
    status = 409;
    body = { error: "Already exists", details: { fields: Object.keys(err.keyValue ?? {}) } };
  } else if (isBodyParserError(err)) {
    status = err.status;
    body = { error: err.type === "entity.too.large" ? "Request body too large" : "Invalid JSON" };
  }

  if (status >= 500) req.log.error({ err }, "unhandled error");
  res.status(status).json(body);
};

function isBodyParserError(err: unknown): err is { status: number; type: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    "type" in err &&
    "status" in err &&
    typeof err.status === "number" &&
    typeof err.type === "string"
  );
}

function isDuplicateKeyError(
  err: unknown,
): err is { code: 11000; keyValue?: Record<string, unknown> } {
  return typeof err === "object" && err !== null && "code" in err && err.code === 11000;
}
