import { Request, Response, NextFunction } from "express";
import { createHash } from "node:crypto";
import arcjet, { fixedWindow, detectBot } from "@arcjet/node";
import { logger } from "../config/logger.js";
import { config } from "../config/env.js";

const isProduction = config.env === "production";
const arcjetKey = config.arcjetKey;

export const prRateLimitAj = arcjetKey
  ? arcjet({
      key: arcjetKey,
      rules: [
        fixedWindow({
          mode: isProduction ? "LIVE" : "DRY_RUN",
          max: 10,
          window: "1m",
        }),
      ],
    })
  : null;

export const formMutationRateLimitAj = arcjetKey
  ? arcjet({
      key: arcjetKey,
      rules: [
        fixedWindow({
          mode: isProduction ? "LIVE" : "DRY_RUN",
          max: 20,
          window: "1m",
        }),
      ],
    })
  : null;

export const apiWriteRateLimitAj = arcjetKey
  ? arcjet({
      key: arcjetKey,
      rules: [
        fixedWindow({
          mode: isProduction ? "LIVE" : "DRY_RUN",
          max: 120,
          window: "1m",
        }),
      ],
    })
  : null;

export const tsrfBotDetectionAj = arcjetKey
  ? arcjet({
      key: arcjetKey,
      rules: [
        detectBot({
          mode: isProduction ? "LIVE" : "DRY_RUN",
          allow: [],
        }),
      ],
    })
  : null;

export const authRateLimitAj = arcjetKey
  ? arcjet({
      key: arcjetKey,
      rules: [
        fixedWindow({
          mode: isProduction ? "LIVE" : "DRY_RUN",
          max: 8,
          window: "15m",
        }),
      ],
    })
  : null;

const authFallbackWindows = new Map<
  string,
  { count: number; resetAt: number }
>();
let lastAuthSweep = 0;
const AUTH_WINDOW_MS = 15 * 60_000;
const AUTH_PRODUCTION_LIMIT = 8;
const AUTH_DEVELOPMENT_LIMIT = 50;

type ArcjetClient = NonNullable<typeof prRateLimitAj>;

async function checkArcjet(
  req: Request,
  res: Response,
  client: ArcjetClient | null,
  policy: string,
  deniedStatus: number,
  deniedMessage: string,
): Promise<boolean> {
  if (config.env === "test") return true;

  if (!client) {
    if (config.env !== "production") return true;
    logger.error(
      { policy },
      "[Arcjet] Required production policy is not configured",
    );
    res.status(503).json({
      error: "Service Unavailable",
      message: "Required request protection is not configured.",
    });
    return false;
  }

  try {
    const decision = await client.protect(req);
    if (decision.isDenied()) {
      logger.warn({ ip: req.ip, policy }, "[Arcjet] Request denied");
      res.status(deniedStatus).json({
        error: deniedStatus === 403 ? "Forbidden" : "Too Many Requests",
        message: deniedMessage,
      });
      return false;
    }
    return true;
  } catch (error) {
    if (config.env === "production") {
      logger.error(
        { error, policy },
        "[Arcjet] Required production policy failed",
      );
      res.status(503).json({
        error: "Service Unavailable",
        message: "Request protection is temporarily unavailable.",
      });
      return false;
    }
    logger.warn(
      { error, policy },
      "[Arcjet] Policy check failed; continuing outside production",
    );
    return true;
  }
}

function authRateLimitResponse(res: Response, retryAfterMs: number) {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  const minutes = Math.ceil(retryAfterSeconds / 60);
  res.setHeader("Retry-After", String(retryAfterSeconds));
  res.status(429).json({
    error: "Too Many Requests",
    retryAfterSeconds,
    message: `Too many attempts. Please wait about ${minutes} minute${minutes === 1 ? "" : "s"} before trying again.`,
  });
}

function consumeAuthWindow(
  key: string,
  now: number,
  limit: number,
): number | null {
  const current = authFallbackWindows.get(key);
  if (!current || current.resetAt <= now) {
    authFallbackWindows.set(key, { count: 1, resetAt: now + AUTH_WINDOW_MS });
    return null;
  }
  if (current.count >= limit) return current.resetAt - now;
  current.count += 1;
  return null;
}

export async function rateLimitAuthentication(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (
    !(await checkArcjet(
      req,
      res,
      authRateLimitAj,
      "authentication rate limit",
      429,
      "Too many authentication attempts. Please retry later.",
    ))
  )
    return;

  const now = Date.now();
  if (now - lastAuthSweep >= 60_000) {
    for (const [key, window] of authFallbackWindows) {
      if (window.resetAt <= now) authFallbackWindows.delete(key);
    }
    lastAuthSweep = now;
  }
  const endpoint = req.path.includes("/signup") ? "signup" : "login";
  const ipKey = `ip:${endpoint}:${req.ip || "unknown"}`;
  const accountValue =
    typeof req.body?.email === "string"
      ? req.body.email.trim().toLowerCase()
      : "";
  const accountKey = accountValue
    ? `account:${endpoint}:${createHash("sha256").update(accountValue).digest("hex")}`
    : undefined;
  const newKeys = [ipKey, ...(accountKey ? [accountKey] : [])].filter(
    (key) => !authFallbackWindows.has(key),
  ).length;
  if (authFallbackWindows.size + newKeys > 10_000) {
    authRateLimitResponse(res, AUTH_WINDOW_MS);
    return;
  }
  const limit = isProduction ? AUTH_PRODUCTION_LIMIT : AUTH_DEVELOPMENT_LIMIT;
  const ipRetryAfter = consumeAuthWindow(ipKey, now, limit);
  const accountRetryAfter = accountKey
    ? consumeAuthWindow(accountKey, now, AUTH_PRODUCTION_LIMIT)
    : null;
  const retryAfter = ipRetryAfter ?? accountRetryAfter;
  if (retryAfter !== null) {
    authRateLimitResponse(res, retryAfter);
    return;
  }
  next();
}

export async function rateLimitProcurementWrite(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (
    await checkArcjet(
      req,
      res,
      prRateLimitAj,
      "procurement write rate limit",
      429,
      "Procurement write rate limit exceeded. Please retry later.",
    )
  )
    next();
}

export async function rateLimitFormMutation(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (
    await checkArcjet(
      req,
      res,
      formMutationRateLimitAj,
      "form mutation rate limit",
      429,
      "Form submission rate limit exceeded. Please retry later.",
    )
  )
    next();
}

export async function rateLimitApiWrite(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (
    ["GET", "HEAD", "OPTIONS"].includes(req.method) ||
    req.path.startsWith("/api/auth/")
  ) {
    next();
    return;
  }
  if (
    await checkArcjet(
      req,
      res,
      apiWriteRateLimitAj,
      "API write rate limit",
      429,
      "API write rate limit exceeded. Please retry later.",
    )
  )
    next();
}

export async function protectTsrfIntake(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (
    await checkArcjet(
      req,
      res,
      tsrfBotDetectionAj,
      "TSRF bot protection",
      403,
      "Automated submission blocked by bot protection guardrail.",
    )
  )
    next();
}
