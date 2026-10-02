import { Router, Request, Response } from 'express';
import { MaintenanceService } from '../services/maintenance.service.js';
import { PurchaseRequisitionGatingError } from '../domain/prGating.js';
import { requirePermission } from '../middleware/auth.js';

export const maintenanceRouter = Router();

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
    const error = err as Error;
    res.status(400).json({ error: error.message });
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

    const updated = await MaintenanceService.completePmsOrder(String(req.params.id), actualKm);
    res.json(updated);
  } catch (err: unknown) {
    const error = err as Error;
    res.status(400).json({ error: error.message });
  }
});

// List PMS records
maintenanceRouter.get('/pms', requirePermission('read', 'PMS'), async (req: Request, res: Response) => {
  try {
    const vehicleId = req.query.vehicleId as string | undefined;
    const records = await MaintenanceService.listPmsRecords(vehicleId);
    res.json(records);
  } catch (err: unknown) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
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
    const error = err as Error;
    res.status(400).json({ error: error.message });
  }
});

// List Repair Work Orders
maintenanceRouter.get('/repair', requirePermission('read', 'RepairWorkOrder'), async (req: Request, res: Response) => {
  try {
    const orders = await MaintenanceService.listRepairWorkOrders();
    res.json(orders);
  } catch (err: unknown) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

// File Mandatory Incident Report (unblocks skipped PMS repair)
maintenanceRouter.post('/incident-report', requirePermission('create', 'IncidentReport'), async (req: Request, res: Response) => {
  try {
    const {
      vehicleId,
      repairWorkOrderId,
      reportedBy,
      incidentDate,
      reason,
      damagesDescription,
      preventativeAction,
    } = req.body;

    if (!vehicleId || !repairWorkOrderId || !reportedBy || !incidentDate || !reason || !damagesDescription) {
      res.status(400).json({
        error: 'Missing required fields: vehicleId, repairWorkOrderId, reportedBy, incidentDate, reason, damagesDescription',
      });
      return;
    }

    const report = await MaintenanceService.fileIncidentReport({
      vehicleId,
      repairWorkOrderId,
      reportedBy,
      incidentDate,
      reason,
      damagesDescription,
      preventativeAction,
    });

    res.status(201).json(report);
  } catch (err: unknown) {
    const error = err as Error;
    res.status(400).json({ error: error.message });
  }
});

// PR Gatekeeper Unlock endpoint
maintenanceRouter.post('/work-order/:id/unlock', requirePermission('approve', 'RepairWorkOrder'), async (req: Request, res: Response) => {
  try {
    const { prId } = req.body;
    const unlocked = await MaintenanceService.unlockWorkOrderWithPr(String(req.params.id), prId);
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
    const error = err as Error;
    res.status(400).json({ error: error.message });
  }
});
