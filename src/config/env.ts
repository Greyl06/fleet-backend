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

export const config = {
  env,
  port: parseInt(process.env.PORT || "5000", 10),
  databaseUrl:
    process.env.DATABASE_URL ||
    "postgresql://postgres:pass1234@localhost:5432/FleetDB",
  arcjetKey: process.env.ARCJET_KEY || "",
  allowDevHeaderAuth:
    env === "test" ||
    (env !== "production" && process.env.ALLOW_DEV_AUTH_HEADERS === "true"),
  entraTenantId: process.env.ENTRA_TENANT_ID || "",
  entraApiAudience: process.env.ENTRA_API_AUDIENCE || "",
  entraRoleMap: parseRoleMap(process.env.ENTRA_ROLE_MAP_JSON),
  sessionSecret:
    process.env.AUTH_SESSION_SECRET ||
    (env === "production" ? "" : "development-only-change-me"),
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
