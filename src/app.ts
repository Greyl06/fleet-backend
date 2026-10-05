import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
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
import { authMiddleware } from "./middleware/auth.js";
import { activityAuditMiddleware } from "./middleware/activity-audit.js";
import { config } from "./config/env.js";
import { logger } from "./config/logger.js";

export const app = express();

// Global Middlewares
app.use(cors({ origin: config.frontendOrigin, credentials: true }));
app.use(express.json());
app.use(authMiddleware);
app.use(activityAuditMiddleware);

// Health check
app.get("/api/health", (req: Request, res: Response) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "Hulma Fleet Logistics & Maintenance Management API",
  });
});

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

// Central Error Handler
app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err }, "[API Error]");
  res.status(err.status || 500).json({
    error: err.name || "InternalServerError",
    message: err.message || "An unexpected error occurred.",
  });
});
