import { Router, Request, Response } from "express";
import {
  InvalidFulfillmentTransitionError,
  ProcurementService,
  WorkOrderNotFoundError,
} from "../services/procurement.service.js";
import { rateLimitProcurementWrite } from "../middleware/arcjet.js";
import { currentUser, requirePermission } from "../middleware/auth.js";
import { purchaseRequisitionScope } from "../auth/scope.js";
import { NotFoundError, sendError } from "../http/errors.js";
import { requireUuid } from "../http/validation.js";
import { parseOffsetPage, setPaginationHeaders } from "./pagination.js";

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
      sendError(res, err);
    }
  },
);

// List PRs
procurementRouter.get(
  "/pr",
  requirePermission("read", "PurchaseRequisition"),
  async (req: Request, res: Response) => {
    try {
      const page = parseOffsetPage(req.query);
      if (!page) {
        res.status(400).json({ error: "Invalid pagination. Use limit 1-500 and offset 0-100000." });
        return;
      }
      const result = await ProcurementService.listPrs(
        page,
        purchaseRequisitionScope(req.user),
      );
      setPaginationHeaders(res, page, result.hasMore);
      res.json(result.items);
    } catch (err: unknown) {
      sendError(res, err);
    }
  },
);

// Get PR by ID
procurementRouter.get(
  "/pr/:id",
  requirePermission("read", "PurchaseRequisition"),
  async (req: Request, res: Response) => {
    try {
      const pr = await ProcurementService.getPrById(
        requireUuid(req.params.id, "PR id"),
        purchaseRequisitionScope(req.user),
      );
      if (!pr) throw new NotFoundError("Purchase requisition not found.");
      res.json(pr);
    } catch (err: unknown) {
      sendError(res, err);
    }
  },
);

// Approve PR. The approver identity always comes from the authenticated session.
procurementRouter.patch(
  "/pr/:id/approve",
  rateLimitProcurementWrite,
  requirePermission("approve", "PurchaseRequisition"),
  async (req: Request, res: Response) => {
    try {
      const approved = await ProcurementService.approvePr(
        requireUuid(req.params.id, "PR id"),
        currentUser(req),
        purchaseRequisitionScope(req.user),
      );
      res.json(approved);
    } catch (err: unknown) {
      sendError(res, err);
    }
  },
);

// List work orders for procurement fulfillment
procurementRouter.get(
  "/orders",
  requirePermission("read", "RepairWorkOrder"),
  async (req: Request, res: Response) => {
    try {
      const page = parseOffsetPage(req.query);
      if (!page) {
        res.status(400).json({ error: "Invalid pagination. Use limit 1-500 and offset 0-100000." });
        return;
      }
      const result = await ProcurementService.listProcurementWorkOrders(page);
      setPaginationHeaders(res, page, result.hasMore);
      res.json(result.items);
    } catch (err: unknown) {
      sendError(res, err);
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
        requireUuid(req.params.id, "Work order id"),
        status,
        notes,
      );
      res.json(updated);
    } catch (err: unknown) {
      if (err instanceof WorkOrderNotFoundError) {
        res
          .status(404)
          .json({ error: "Work order not found", message: err.message });
        return;
      }
      if (err instanceof InvalidFulfillmentTransitionError) {
        res.status(409).json({
          error: "Invalid fulfillment transition",
          message: err.message,
        });
        return;
      }
      sendError(res, err);
    }
  },
);
