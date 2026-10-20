import { Router, type Request, type Response, type NextFunction } from 'express';
import { AnalyticsService } from '../services/analytics.service.js';
import { logger } from '../config/logger.js';

export const analyticsRouter = Router();

function requireTcoPermission(req: Request, res: Response, next: NextFunction) {
  if (
    req.ability?.can('read', 'Vehicle') ||
    req.ability?.can('read', 'SubmissionReport') ||
    req.ability?.can('read', 'all')
  ) {
    return next();
  }
  res.status(403).json({
    error: 'Forbidden',
    message: 'TCO Analytics requires fleet management or financial reporting permissions.',
  });
}

// GET /api/analytics/tco - Complete Fleet TCO & Cost-per-Kilometer Analytics (TICKET-113)
analyticsRouter.get('/tco', requireTcoPermission, async (req: Request, res: Response) => {
  try {
    const summary = await AnalyticsService.getFleetTcoAnalytics();
    res.json(summary);
  } catch (err: unknown) {
    const error = err as Error;
    logger.error({ error: error.message }, '[AnalyticsRouter] Failed to retrieve TCO summary');
    res.status(500).json({ error: 'Failed to retrieve TCO analytics', message: error.message });
  }
});

// GET /api/analytics/vehicles/:id - Vehicle Specific TCO & Repair History Drilldown
analyticsRouter.get('/vehicles/:id', requireTcoPermission, async (req: Request, res: Response) => {
  try {
    const vehicleId = String(req.params.id);
    const detail = await AnalyticsService.getVehicleTcoDetail(vehicleId);
    if (!detail) {
      res.status(404).json({ error: 'Vehicle not found' });
      return;
    }
    res.json(detail);
  } catch (err: unknown) {
    const error = err as Error;
    logger.error({ error: error.message }, '[AnalyticsRouter] Failed to retrieve vehicle TCO detail');
    res.status(500).json({ error: 'Failed to retrieve vehicle TCO detail', message: error.message });
  }
});
