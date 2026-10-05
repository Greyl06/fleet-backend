import { Request, Response, NextFunction } from 'express';
import { createHash } from 'node:crypto';
import arcjet, { fixedWindow, detectBot } from '@arcjet/node';
import { logger } from '../config/logger.js';
import { config } from '../config/env.js';

const isProduction = config.env === 'production';
const arcjetKey = config.arcjetKey;

export const prRateLimitAj = arcjetKey
  ? arcjet({
      key: arcjetKey,
      rules: [
        fixedWindow({
          mode: isProduction ? 'LIVE' : 'DRY_RUN',
          max: 10,
          window: '1m',
        }),
      ],
    })
  : null;

export const tsrfBotDetectionAj = arcjetKey
  ? arcjet({
      key: arcjetKey,
      rules: [
        detectBot({
          mode: isProduction ? 'LIVE' : 'DRY_RUN',
          allow: [],
        }),
      ],
    })
  : null;

export const authRateLimitAj = arcjetKey
  ? arcjet({
      key: arcjetKey,
      rules: [fixedWindow({ mode: isProduction ? 'LIVE' : 'DRY_RUN', max: 8, window: '15m' })],
    })
  : null;

const authFallbackWindows = new Map<string, { count: number; resetAt: number }>();
let lastAuthSweep = 0;
const AUTH_WINDOW_MS = 15 * 60_000;
const AUTH_PRODUCTION_LIMIT = 8;
const AUTH_DEVELOPMENT_LIMIT = 50;

function authRateLimitResponse(res: Response, retryAfterMs: number) {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  const minutes = Math.ceil(retryAfterSeconds / 60);
  res.setHeader('Retry-After', String(retryAfterSeconds));
  res.status(429).json({
    error: 'Too Many Requests',
    retryAfterSeconds,
    message: `Too many attempts. Please wait about ${minutes} minute${minutes === 1 ? '' : 's'} before trying again.`,
  });
}

function consumeAuthWindow(key: string, now: number, limit: number): number | null {
  const current = authFallbackWindows.get(key);
  if (!current || current.resetAt <= now) {
    authFallbackWindows.set(key, { count: 1, resetAt: now + AUTH_WINDOW_MS });
    return null;
  }
  if (current.count >= limit) return current.resetAt - now;
  current.count += 1;
  return null;
}

export async function rateLimitAuthentication(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (authRateLimitAj) {
    try {
      const decision = await authRateLimitAj.protect(req);
      if (decision.isDenied()) {
        authRateLimitResponse(res, AUTH_WINDOW_MS);
        return;
      }
    } catch (error) {
      logger.warn({ error }, '[Arcjet] Authentication rate-limit check failed');
    }
  }

  const now = Date.now();
  if (now - lastAuthSweep >= 60_000) {
    for (const [key, window] of authFallbackWindows) {
      if (window.resetAt <= now) authFallbackWindows.delete(key);
    }
    lastAuthSweep = now;
  }
  const endpoint = req.path.includes('/signup') ? 'signup' : 'login';
  const ipKey = `ip:${endpoint}:${req.ip || 'unknown'}`;
  const accountValue = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const accountKey = accountValue
    ? `account:${endpoint}:${createHash('sha256').update(accountValue).digest('hex')}`
    : undefined;
  const newKeys = [ipKey, ...(accountKey ? [accountKey] : [])].filter((key) => !authFallbackWindows.has(key)).length;
  if (authFallbackWindows.size + newKeys > 10_000) {
    authRateLimitResponse(res, AUTH_WINDOW_MS);
    return;
  }
  const limit = isProduction ? AUTH_PRODUCTION_LIMIT : AUTH_DEVELOPMENT_LIMIT;
  const ipRetryAfter = consumeAuthWindow(ipKey, now, limit);
  const accountRetryAfter = accountKey ? consumeAuthWindow(accountKey, now, AUTH_PRODUCTION_LIMIT) : null;
  const retryAfter = ipRetryAfter ?? accountRetryAfter;
  if (retryAfter !== null) {
    authRateLimitResponse(res, retryAfter);
    return;
  }
  next();
}

export async function rateLimitPrApproval(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!prRateLimitAj) {
    next();
    return;
  }

  try {
    const decision = await prRateLimitAj.protect(req);
    if (decision.isDenied()) {
      logger.warn({ ip: req.ip }, '[Arcjet] PR approval rate limit exceeded');
      res.status(429).json({
        error: 'Too Many Requests',
        message: 'Rate limit exceeded on procurement/PR approval endpoint. Please retry later.',
      });
      return;
    }
  } catch (error) {
    logger.warn({ error }, '[Arcjet] Error evaluating PR rate limit');
  }

  next();
}

export async function protectTsrfIntake(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!tsrfBotDetectionAj) {
    next();
    return;
  }

  try {
    const decision = await tsrfBotDetectionAj.protect(req);
    if (decision.isDenied()) {
      logger.warn({ ip: req.ip }, '[Arcjet] TSRF intake blocked by bot detection');
      res.status(403).json({
        error: 'Forbidden',
        message: 'Automated submission blocked by bot protection guardrail.',
      });
      return;
    }
  } catch (error) {
    logger.warn({ error }, '[Arcjet] Error evaluating TSRF bot detection');
  }

  next();
}
