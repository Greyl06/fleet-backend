import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from "prom-client";
import type { NextFunction, Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { pool } from "../db/connection.js";
import { config } from "../config/env.js";
import { logger } from "../config/logger.js";

export const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry });

const requestCount = new Counter({
  name: "http_requests_total",
  help: "Total HTTP requests completed by the API.",
  labelNames: ["method", "route", "status_code"],
  registers: [metricsRegistry],
});
const requestErrors = new Counter({
  name: "http_request_errors_total",
  help: "HTTP requests that completed with a 5xx response.",
  labelNames: ["method", "route"],
  registers: [metricsRegistry],
});
const requestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds.",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2, 5, 10],
  registers: [metricsRegistry],
});
const poolTotal = new Gauge({
  name: "postgres_pool_connections_total",
  help: "Configured PostgreSQL pool connection limit.",
  registers: [metricsRegistry],
});
const poolIdle = new Gauge({
  name: "postgres_pool_connections_idle",
  help: "Idle PostgreSQL pool connections.",
  registers: [metricsRegistry],
});
const poolWaiting = new Gauge({
  name: "postgres_pool_waiting_clients",
  help: "Clients waiting for a PostgreSQL pool connection.",
  registers: [metricsRegistry],
});

export function requestMetrics(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (
    req.path === "/metrics" ||
    req.path === "/health" ||
    req.path === "/ready" ||
    req.path === "/health/live" ||
    req.path === "/health/ready" ||
    req.path === "/api/health"
  ) {
    next();
    return;
  }

  const startedAt = process.hrtime.bigint();
  res.once("finish", () => {
    const routePath =
      typeof req.route?.path === "string"
        ? `${req.baseUrl}${req.route.path}`
        : "unmatched";
    const labels = {
      method: req.method,
      route: routePath,
      status_code: String(res.statusCode),
    };
    const durationSeconds =
      Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;

    requestCount.inc(labels);
    requestDuration.observe(labels, durationSeconds);
    if (res.statusCode >= 500) {
      requestErrors.inc({ method: req.method, route: routePath });
    }
  });
  next();
}

export async function metricsHandler(
  _req: Request,
  res: Response,
): Promise<void> {
  poolTotal.set(pool.options.max);
  poolIdle.set(pool.idleCount);
  poolWaiting.set(pool.waitingCount);
  res.setHeader("Content-Type", metricsRegistry.contentType);
  res.end(await metricsRegistry.metrics());
}

export function requireMetricsToken(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!config.metricsToken) {
    if (config.env !== "production") {
      next();
      return;
    }
    logger.error("[Metrics] METRICS_TOKEN must be configured in production");
    res.status(503).json({ error: "Metrics endpoint is not configured." });
    return;
  }

  const authorization = req.get("authorization") ?? "";
  const supplied = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  const expectedBuffer = Buffer.from(config.metricsToken);
  const suppliedBuffer = Buffer.from(supplied);
  if (
    suppliedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(suppliedBuffer, expectedBuffer)
  ) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}
