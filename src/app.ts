import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import { vehicleRouter } from "./routes/vehicle.routes.js";
import { tsrfRouter } from "./routes/tsrf.routes.js";
import { maintenanceRouter } from "./routes/maintenance.routes.js";
import { procurementRouter } from "./routes/procurement.routes.js";
import { rolesRouter } from "./routes/roles.routes.js";
import { referenceDataRouter } from "./routes/reference-data.routes.js";
import { userRouter } from "./routes/user.routes.js";
import { activityLogRouter } from "./routes/activity-log.routes.js";
import { lovRouter } from "./routes/lov.routes.js";
import { formsRouter } from "./routes/forms.routes.js";
import { authRouter } from "./routes/auth.routes.js";
import { reportsRouter } from "./routes/reports.routes.js";
import { themeRouter } from "./routes/theme.routes.js";
import { dashboardRouter } from "./routes/dashboard.routes.js";
import { analyticsRouter } from "./routes/analytics.routes.js";
import { authMiddleware } from "./middleware/auth.js";
import {
  rateLimitApiTraffic,
  rateLimitApiWrite,
} from "./middleware/arcjet.js";
import { activityAuditMiddleware } from "./middleware/activity-audit.js";
import { config } from "./config/env.js";
import { logger } from "./config/logger.js";
import { checkDatabaseReadiness } from "./db/connection.js";
import { sendError } from "./http/errors.js";
import {
  metricsHandler,
  requestMetrics,
  requireMetricsToken,
} from "./middleware/metrics.js";

export const app = express();
app.disable("x-powered-by");

// JSON-only API: nothing it serves should execute scripts, be framed, or be
// sniffed into another content type.
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: "same-site" },
    referrerPolicy: { policy: "no-referrer" },
    strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true },
    xFrameOptions: { action: "deny" },
  }),
);

// Global Middlewares
app.use(
  cors({
    origin: config.frontendOrigin,
    credentials: true,
    exposedHeaders: ["X-Page-Limit", "X-Has-More", "X-Next-Offset"],
  }),
);

const live = (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok" });
};
app.get("/health/live", live);
app.get("/health", live);
app.get("/api/health", live);
const ready = async (_req: Request, res: Response) => {
  try {
    await checkDatabaseReadiness();
    res.status(200).json({ status: "ready" });
  } catch (error) {
    logger.error({ error }, "[Health] Readiness check failed");
    res.status(503).json({ status: "not_ready", dependency: "database" });
  }
};
app.get("/health/ready", ready);
app.get("/ready", ready);
app.get("/metrics", requireMetricsToken, metricsHandler);

app.use(requestMetrics);
app.use(rateLimitApiTraffic);
app.use(rateLimitApiWrite);
app.use(express.json({ limit: config.jsonBodyLimit }));
app.use(authMiddleware);
app.use(activityAuditMiddleware);

// Mount modular API routers
app.use("/api/vehicles", vehicleRouter);
app.use("/api/tsrf", tsrfRouter);
app.use("/api/maintenance", maintenanceRouter);
app.use("/api/procurement", procurementRouter);
app.use("/api/roles", rolesRouter);
app.use("/api/reference-data", referenceDataRouter);
app.use("/api/users", userRouter);
app.use("/api/activity-logs", activityLogRouter);
app.use("/api/auth", authRouter);
app.use("/api/lov", lovRouter);
app.use("/api/forms", formsRouter);
app.use("/api/reports", reportsRouter);
app.use("/api/theme", themeRouter);
app.use("/api/dashboard", dashboardRouter);
app.use("/api/analytics", analyticsRouter);

// Central Error Handler: only typed AppErrors and known client errors expose a
// message; everything else is logged and returned as a generic 500.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  sendError(res, err);
});
