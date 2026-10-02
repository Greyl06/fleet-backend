import { Request, Response, NextFunction } from 'express';
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
