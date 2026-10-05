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

function consumeAuthWindow(key: string, now: number): boolean {
  const current = authFallbackWindows.get(key);
  if (!current || current.resetAt <= now) {
    authFallbackWindows.set(key, { count: 1, resetAt: now + 15 * 60_000 });
    return true;
  }
  if (current.count >= 8) return false;
  current.count += 1;
  return true;
}

export async function rateLimitAuthentication(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (authRateLimitAj) {
    try {
      const decision = await authRateLimitAj.protect(req);
      if (decision.isDenied()) {
        res.status(429).json({ error: 'Too Many Requests', message: 'Please wait before trying again.' });
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
  const ipKey = `ip:${req.ip || 'unknown'}`;
  const accountValue = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const accountKey = accountValue ? `account:${createHash('sha256').update(accountValue).digest('hex')}` : undefined;
  const newKeys = [ipKey, ...(accountKey ? [accountKey] : [])].filter((key) => !authFallbackWindows.has(key)).length;
  if (authFallbackWindows.size + newKeys > 10_000) {
    res.status(429).json({ error: 'Too Many Requests', message: 'Please wait before trying again.' });
    return;
  }
  if (!consumeAuthWindow(ipKey, now) || (accountKey && !consumeAuthWindow(accountKey, now))) {
    res.status(429).json({ error: 'Too Many Requests', message: 'Please wait before trying again.' });
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
