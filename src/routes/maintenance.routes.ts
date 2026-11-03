import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { MaintenanceService } from '../services/maintenance.service.js';
import { PurchaseRequisitionGatingError } from '../domain/prGating.js';
import { currentUser, requirePermission } from '../middleware/auth.js';
import { purchaseRequisitionScope } from '../auth/scope.js';
import { sendError } from '../http/errors.js';
import { parseBody, requireUuid } from '../http/validation.js';
import { parseOffsetPage, setPaginationHeaders } from './pagination.js';

export const maintenanceRouter = Router();

const incidentReportSchema = z.object({
  vehicleId: z.string().uuid(),
  repairWorkOrderId: z.string().uuid(),
  // Accepted for backward compatibility but ignored: the reporter is the authenticated user.
  reportedBy: z.string().optional(),
  incidentDate: z.coerce
    .date()
    .refine((date) => date.getTime() <= Date.now() + 5 * 60_000, 'must not be in the future'),
  reason: z.string().trim().min(1).max(2000),
  damagesDescription: z.string().trim().min(1).max(4000),
  preventativeAction: z.string().trim().max(4000).optional(),
});

const unlockSchema = z.object({
  prId: z.string().uuid().optional(),
});

// Schedule PMS
maintenanceRouter.post('/pms/schedule', requirePermission('create', 'PMS'), async (req: Request, res: Response) => {
  try {
    const { vehicleId, pmsKm, notes } = req.body;
    if (!vehicleId || typeof pmsKm !== 'number') {
      res.status(400).json({ error: 'vehicleId and pmsKm (number) are required' });
      return;
    }

    const pms = await MaintenanceService.schedulePmsOrder({ vehicleId, pmsKm, notes });
    res.status(201).json(pms);
  } catch (err: unknown) {
    sendError(res, err);
  }
});

// Complete PMS
maintenanceRouter.post('/pms/:id/complete', requirePermission('update', 'PMS'), async (req: Request, res: Response) => {
  try {
    const { actualKm } = req.body;
    if (typeof actualKm !== 'number') {
      res.status(400).json({ error: 'actualKm (number) is required' });
      return;
    }

    const updated = await MaintenanceService.completePmsOrder(requireUuid(req.params.id, 'PMS id'), actualKm);
    res.json(updated);
  } catch (err: unknown) {
    sendError(res, err);
  }
});

// List PMS records
maintenanceRouter.get('/pms', requirePermission('read', 'PMS'), async (req: Request, res: Response) => {
  try {
    const page = parseOffsetPage(req.query);
    if (!page) {
      res.status(400).json({ error: 'Invalid pagination. Use limit 1-500 and offset 0-100000.' });
      return;
    }
    const vehicleId = req.query.vehicleId as string | undefined;
    const result = await MaintenanceService.listPmsRecords(vehicleId, page);
    setPaginationHeaders(res, page, result.hasMore);
    res.json(result.items);
  } catch (err: unknown) {
    sendError(res, err);
  }
});

// Create Repair Work Order (with PMS compliance audit)
maintenanceRouter.post('/repair', requirePermission('create', 'RepairWorkOrder'), async (req: Request, res: Response) => {
  try {
    const { vehicleId, description, linkedPrId } = req.body;
    if (!vehicleId || !description) {
      res.status(400).json({ error: 'vehicleId and description are required' });
      return;
    }

    const result = await MaintenanceService.createRepairWorkOrder({
      vehicleId,
      description,
      linkedPrId,
    });

    res.status(201).json(result);
  } catch (err: unknown) {
    sendError(res, err);
  }
});

// List Repair Work Orders
maintenanceRouter.get('/repair', requirePermission('read', 'RepairWorkOrder'), async (req: Request, res: Response) => {
  try {
    const page = parseOffsetPage(req.query);
    if (!page) {
      res.status(400).json({ error: 'Invalid pagination. Use limit 1-500 and offset 0-100000.' });
      return;
    }
    const result = await MaintenanceService.listRepairWorkOrders(page);
    setPaginationHeaders(res, page, result.hasMore);
    res.json(result.items);
  } catch (err: unknown) {
    sendError(res, err);
  }
});

// File Mandatory Incident Report (unblocks skipped PMS repair)
maintenanceRouter.post('/incident-report', requirePermission('create', 'IncidentReport'), async (req: Request, res: Response) => {
  try {
    const { reportedBy: _ignored, ...input } = parseBody(incidentReportSchema, req.body);
    const report = await MaintenanceService.fileIncidentReport(input, currentUser(req));
    res.status(201).json(report);
  } catch (err: unknown) {
    sendError(res, err);
  }
});

// PR Gatekeeper Unlock endpoint
maintenanceRouter.post('/work-order/:id/unlock', requirePermission('approve', 'RepairWorkOrder'), async (req: Request, res: Response) => {
  try {
    const { prId } = parseBody(unlockSchema, req.body ?? {});
    const unlocked = await MaintenanceService.unlockWorkOrderWithPr(
      requireUuid(req.params.id, 'Work order id'),
      prId,
      purchaseRequisitionScope(req.user),
    );
    res.json({
      status: 'unlocked',
      message: 'Work order successfully unlocked via approved PR gatekeeper.',
      order: unlocked,
    });
  } catch (err: unknown) {
    if (err instanceof PurchaseRequisitionGatingError) {
      res.status(403).json({
        error: 'PR Gating Block',
        message: err.message,
      });
      return;
    }
    sendError(res, err);
  }
});
