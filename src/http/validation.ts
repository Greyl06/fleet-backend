import { z } from "zod";
import { ValidationError } from "./errors.js";

const uuidSchema = z.string().uuid();

export function requireUuid(value: unknown, label = "id"): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) throw new ValidationError(`${label} must be a valid UUID.`);
  return parsed.data;
}

export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join(".");
    throw new ValidationError(
      field ? `${field}: ${issue.message}` : (issue?.message ?? "Invalid request body."),
    );
  }
  return parsed.data;
}
