import dotenv from "dotenv";
dotenv.config();

function parseRoleMap(value: string | undefined): Record<string, string> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

const env = process.env.NODE_ENV || "development";

const PLACEHOLDER_SECRET = /change-?me|replace|development-only|placeholder|example/i;

/** Refuses to start production with a missing, short, or placeholder secret. */
function productionSecret(
  name: string,
  value: string | undefined,
  developmentFallback: string,
): string {
  if (env !== "production") return value || developmentFallback;
  if (!value || value.length < 32 || PLACEHOLDER_SECRET.test(value)) {
    throw new Error(
      `${name} must be a random value of at least 32 characters in production.`,
    );
  }
  return value;
}

function positiveInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return parsed;
}

export const config = {
  env,
  port: positiveInteger("PORT", process.env.PORT, 5000, 65535),
  databaseUrl:
    process.env.DATABASE_URL ||
    "postgresql://postgres:pass1234@localhost:5432/FleetDB",
  dbPoolMax: positiveInteger("DB_POOL_MAX", process.env.DB_POOL_MAX, 10, 50),
  apiRequestsPerMinute: positiveInteger(
    "API_REQUESTS_PER_MINUTE",
    process.env.API_REQUESTS_PER_MINUTE,
    300,
    100_000,
  ),
  requestTimeoutMs: positiveInteger(
    "REQUEST_TIMEOUT_MS",
    process.env.REQUEST_TIMEOUT_MS,
    30_000,
    120_000,
  ),
  jsonBodyLimit: process.env.JSON_BODY_LIMIT || "1mb",
  otelEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "",
  otelServiceName: process.env.OTEL_SERVICE_NAME || "fleet-backend",
  metricsToken: process.env.METRICS_TOKEN || "",
  arcjetKey: process.env.ARCJET_KEY || "",
  allowDevHeaderAuth:
    env === "test" ||
    (env !== "production" && process.env.ALLOW_DEV_AUTH_HEADERS === "true"),
  entraTenantId: process.env.ENTRA_TENANT_ID || "",
  entraApiAudience: process.env.ENTRA_API_AUDIENCE || "",
  entraRoleMap: parseRoleMap(process.env.ENTRA_ROLE_MAP_JSON),
  sessionSecret: productionSecret(
    "AUTH_SESSION_SECRET",
    process.env.AUTH_SESSION_SECRET,
    "development-only-change-me",
  ),
  sessionTtlHours: Number.parseInt(
    process.env.AUTH_SESSION_TTL_HOURS || "8",
    10,
  ),
  passwordResetTtlMinutes: Number.parseInt(
    process.env.PASSWORD_RESET_TTL_MINUTES || "30",
    10,
  ),
  frontendOrigin: process.env.FRONTEND_ORIGIN || "http://localhost:5173",
  smtpHost: process.env.SMTP_HOST || "",
  smtpPort: Number.parseInt(process.env.SMTP_PORT || "587", 10),
  smtpSecure: process.env.SMTP_SECURE === "true",
  smtpUser: process.env.SMTP_USER || "",
  smtpPassword: process.env.SMTP_PASSWORD || "",
  smtpFrom: process.env.SMTP_FROM || "Fleet Hub <no-reply@localhost>",
};
