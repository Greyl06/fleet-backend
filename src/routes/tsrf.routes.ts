import { Router, Request, Response } from "express";
import { TsrfService } from "../services/tsrf.service.js";
import { protectTsrfIntake } from "../middleware/arcjet.js";
import { requirePermission } from "../middleware/auth.js";

export const tsrfRouter = Router();

// POST /api/tsrf - Submit new TSRF request (protected by Arcjet bot detection)
tsrfRouter.post(
  "/",
  protectTsrfIntake,
  requirePermission("create", "TSRFRequest"),
  async (req: Request, res: Response) => {
    try {
      const {
        department,
        projectName,
        origin,
        destination,
        stops,
        passengers,
        cargo,
        vehicleType,
        assignedVehicleId,
        assignedDriver,
        departureDate,
        callTime,
        submissionDate,
      } = req.body;

      if (
        !department ||
        !projectName ||
        !origin ||
        !destination ||
        !departureDate ||
        !callTime
      ) {
        res.status(400).json({
          error:
            "Missing required fields: department, projectName, origin, destination, departureDate, callTime",
        });
        return;
      }

      const created = await TsrfService.createTsrf({
        department,
        projectName,
        origin,
        destination,
        stops,
        passengers,
        cargo,
        vehicleType,
        assignedVehicleId,
        assignedDriver,
        departureDate,
        callTime,
        submissionDate: submissionDate ? new Date(submissionDate) : undefined,
      });

      res.status(201).json(created);
    } catch (err: unknown) {
      const error = err as Error;
      res.status(400).json({ error: error.message });
    }
  },
);

// GET /api/tsrf - List all TSRF requests
tsrfRouter.get(
  "/",
  requirePermission("read", "TSRFRequest"),
  async (req: Request, res: Response) => {
    try {
      const list = await TsrfService.listTsrf();
      res.json(list);
    } catch (err: unknown) {
      const error = err as Error;
      res.status(500).json({ error: error.message });
    }
  },
);

// GET /api/tsrf/:id
tsrfRouter.get(
  "/:id",
  requirePermission("read", "TSRFRequest"),
  async (req: Request, res: Response) => {
    try {
      const item = await TsrfService.getTsrfById(String(req.params.id));
      if (!item) {
        res.status(404).json({ error: "TSRF request not found" });
        return;
      }
      res.json(item);
    } catch (err: unknown) {
      const error = err as Error;
      res.status(500).json({ error: error.message });
    }
  },
);

// PATCH /api/tsrf/:id/endorse - Multi-tier sign-off
tsrfRouter.patch(
  "/:id/endorse",
  requirePermission("approve", "TSRFRequest"),
  async (req: Request, res: Response) => {
    try {
      const { role, action } = req.body;
      if (!role || !action) {
        res
          .status(400)
          .json({ error: "role and action (approve/reject) are required" });
        return;
      }

      const signedInRole = req.user?.role;
      if (role === "department_head") {
        const tsrf = await TsrfService.getTsrfById(String(req.params.id));
        if (!tsrf) {
          res.status(404).json({ error: "TSRF request not found" });
          return;
        }
        if (
          signedInRole !== "admin" &&
          (signedInRole !== "approver" ||
            tsrf.departmentHeadUserId !== req.user?.id)
        ) {
          res
            .status(403)
            .json({
              error:
                "Only the assigned department head can approve this request.",
            });
          return;
        }
      } else if (
        role === "finance_manager" &&
        signedInRole !== "admin" &&
        signedInRole !== "finance"
      ) {
        res.status(403).json({ error: "Only Finance can approve this stage." });
        return;
      } else if (
        role === "logistics_head" &&
        signedInRole !== "admin" &&
        signedInRole !== "fleet_team"
      ) {
        res
          .status(403)
          .json({ error: "Only Fleet & Logistics can approve this stage." });
        return;
      }

      const updated = await TsrfService.endorseTsrf(
        String(req.params.id),
        role,
        action,
      );
      res.json(updated);
    } catch (err: unknown) {
      const error = err as Error;
      res.status(400).json({ error: error.message });
    }
  },
);

// POST /api/tsrf/:id/complete-trip - Returning trip logging ending KM
tsrfRouter.post(
  "/:id/complete-trip",
  requirePermission("update", "TSRFRequest"),
  async (req: Request, res: Response) => {
    try {
      const { endingKm, assignedVehicleId } = req.body;
      if (typeof endingKm !== "number") {
        res.status(400).json({ error: "endingKm (number) is required" });
        return;
      }

      const result = await TsrfService.completeTrip(String(req.params.id), {
        endingKm,
        assignedVehicleId,
      });

      res.json(result);
    } catch (err: unknown) {
      const error = err as Error;
      res.status(400).json({ error: error.message });
    }
  },
);
