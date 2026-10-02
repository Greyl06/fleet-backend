import { Router, Request, Response } from 'express';
import { desc, eq } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { activityLogs } from '../db/schema.js';

export const activityLogRouter = Router();

// GET /api/activity-logs - List activity logs with optional module filter
activityLogRouter.get('/', async (req: Request, res: Response) => {
  try {
    const { module: mod, severity } = req.query;
    let query = db.select().from(activityLogs).orderBy(desc(activityLogs.createdAt)).$dynamic();

    if (typeof mod === 'string' && mod) {
      query = query.where(eq(activityLogs.module, mod));
    }
    if (typeof severity === 'string' && severity) {
      query = query.where(eq(activityLogs.severity, severity as any));
    }

    const logs = await query.limit(100);
    res.json(logs);
  } catch (err: unknown) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

// POST /api/activity-logs - Record new audit log
activityLogRouter.post('/', async (req: Request, res: Response) => {
  try {
    const { userName, userRole, action, module: mod, description, severity, metadata } = req.body;
    if (!userName || !action || !mod || !description) {
      res.status(400).json({ error: 'userName, action, module, and description are required' });
      return;
    }

    const [created] = await db.insert(activityLogs).values({
      userName,
      userRole: userRole || 'user',
      action,
      module: mod,
      description,
      severity: severity || 'info',
      metadataJson: metadata ? JSON.stringify(metadata) : '{}',
    }).returning();

    res.status(201).json(created);
  } catch (err: unknown) {
    const error = err as Error;
    res.status(400).json({ error: error.message });
  }
});
