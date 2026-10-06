import { Router, Request, Response } from "express";
import {
  InvalidFulfillmentTransitionError,
  ProcurementService,
  WorkOrderNotFoundError,
} from "../services/procurement.service.js";
import { rateLimitProcurementWrite } from "../middleware/arcjet.js";
import { requirePermission } from "../middleware/auth.js";

export const procurementRouter = Router();

// Create PR
procurementRouter.post(
  "/pr",
  rateLimitProcurementWrite,
  requirePermission("create", "PurchaseRequisition"),
  async (req: Request, res: Response) => {
    try {
      const { department, purpose, amount } = req.body;
      if (!department || !purpose) {
        res.status(400).json({ error: "department and purpose are required" });
        return;
      }

      const pr = await ProcurementService.createPr({
        department,
        purpose,
        amount,
      });
      res.status(201).json(pr);
    } catch (err: unknown) {
      const error = err as Error;
      res.status(400).json({ error: error.message });
    }
  },
);

// List PRs
procurementRouter.get(
  "/pr",
  requirePermission("read", "PurchaseRequisition"),
  async (req: Request, res: Response) => {
    try {
      const list = await ProcurementService.listPrs();
      res.json(list);
    } catch (err: unknown) {
      const error = err as Error;
      res.status(500).json({ error: error.message });
    }
  },
);

// Get PR by ID
procurementRouter.get(
  "/pr/:id",
  requirePermission("read", "PurchaseRequisition"),
  async (req: Request, res: Response) => {
    try {
      const pr = await ProcurementService.getPrById(String(req.params.id));
      if (!pr) {
        res.status(404).json({ error: "PR not found" });
        return;
      }
      res.json(pr);
    } catch (err: unknown) {
      const error = err as Error;
      res.status(500).json({ error: error.message });
    }
  },
);

// Approve PR (Gated Spend - Protected by Arcjet rate limiting & Finance approval permission)
procurementRouter.patch(
  "/pr/:id/approve",
  rateLimitProcurementWrite,
  requirePermission("approve", "PurchaseRequisition"),
  async (req: Request, res: Response) => {
    try {
      const approverName =
        req.user?.name || req.body.approverName || "Finance Manager";
      const approved = await ProcurementService.approvePr(
        String(req.params.id),
        approverName,
      );
      res.json(approved);
    } catch (err: unknown) {
      const error = err as Error;
      res.status(400).json({ error: error.message });
    }
  },
);

// List work orders for procurement fulfillment
procurementRouter.get(
  "/orders",
  requirePermission("read", "RepairWorkOrder"),
  async (req: Request, res: Response) => {
    try {
      const orders = await ProcurementService.listProcurementWorkOrders();
      res.json(orders);
    } catch (err: unknown) {
      const error = err as Error;
      res.status(500).json({ error: error.message });
    }
  },
);

// Update fulfillment status (in_maintenance -> work_completed -> vehicle_operational)
procurementRouter.patch(
  "/orders/:id/status",
  rateLimitProcurementWrite,
  requirePermission("update", "RepairWorkOrder"),
  async (req: Request, res: Response) => {
    try {
      const { status, notes } = req.body;
      if (
        !["in_maintenance", "work_completed", "vehicle_operational"].includes(
          status,
        )
      ) {
        res.status(400).json({
          error:
            "Invalid status. Must be one of: 'in_maintenance', 'work_completed', 'vehicle_operational'",
        });
        return;
      }

      const updated = await ProcurementService.updateFulfillmentStatus(
        String(req.params.id),
        status,
        notes,
      );
      res.json(updated);
    } catch (err: unknown) {
      const error = err as Error;
      if (error instanceof WorkOrderNotFoundError) {
        res
          .status(404)
          .json({ error: "Work order not found", message: error.message });
        return;
      }
      if (error instanceof InvalidFulfillmentTransitionError) {
        res.status(409).json({
          error: "Invalid fulfillment transition",
          message: error.message,
        });
        return;
      }
      res.status(500).json({ error: "Failed to update fulfillment status" });
    }
  },
);
