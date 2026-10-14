import { Router, Request, Response } from "express";
import { desc } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  vehicles,
  purchaseRequisitions,
  tsrfRequests,
  activityLogs,
  formSubmissions,
} from "../db/schema.js";

export const dashboardRouter = Router();

// GET /api/dashboard/stats - Real-time aggregated operational metrics (TICKET-106)
dashboardRouter.get("/stats", async (req: Request, res: Response) => {
  try {
    // 1. Vehicle stats
    const vehicleList = await db
      .select({
        id: vehicles.id,
        status: vehicles.status,
        currentKm: vehicles.currentKm,
        lastPmsKm: vehicles.lastPmsKm,
        pmsIntervalKm: vehicles.pmsIntervalKm,
      })
      .from(vehicles);

    const totalVehicles = vehicleList.length;
    const activeVehicles = vehicleList.filter(
      (v) => v.status === "active",
    ).length;
    const pmsDueVehicles = vehicleList.filter(
      (v) =>
        v.status === "pms_due" ||
        v.currentKm - v.lastPmsKm >= v.pmsIntervalKm,
    ).length;
    const pmsApproaching = vehicleList.filter((v) => {
      const remaining = v.lastPmsKm + v.pmsIntervalKm - v.currentKm;
      return remaining > 0 && remaining <= 500 && v.status === "active";
    }).length;

    // 2. PR Stats
    const prList = await db
      .select({
        id: purchaseRequisitions.id,
        status: purchaseRequisitions.status,
        amount: purchaseRequisitions.amount,
      })
      .from(purchaseRequisitions);

    const pendingPrs = prList.filter((pr) => pr.status === "pending");
    const pendingPrCount = pendingPrs.length;
    const pendingPrTotalValue = pendingPrs.reduce(
      (sum, pr) => sum + (pr.amount || 0),
      0,
    );

    // 3. TSRF Stats (from tsrfRequests and formSubmissions)
    const tsrfs = await db
      .select({
        id: tsrfRequests.id,
        tripStatus: tsrfRequests.tripStatus,
        approvalStatus: tsrfRequests.approvalStatus,
      })
      .from(tsrfRequests);

    const openTsrfList = tsrfs.filter((t) =>
      ["requested", "approved", "dispatched", "in_transit"].includes(
        t.tripStatus,
      ),
    );
    const dispatchedTsrfCount = tsrfs.filter((t) =>
      ["dispatched", "in_transit"].includes(t.tripStatus),
    ).length;

    const submissions = await db
      .select({
        id: formSubmissions.id,
        status: formSubmissions.status,
      })
      .from(formSubmissions);

    const openSubmissionsCount = submissions.filter((s) =>
      ["draft", "in_review", "in_progress"].includes(s.status),
    ).length;

    const totalOpenTsrfCount = openTsrfList.length + openSubmissionsCount;

    // 4. Recent Activity
    const recentLogs = await db
      .select()
      .from(activityLogs)
      .orderBy(desc(activityLogs.createdAt))
      .limit(10);

    const recentActivity = recentLogs.map((log) => ({
      id: log.id,
      userName: log.userName,
      userRole: log.userRole,
      action: log.action,
      module: log.module,
      description: log.description,
      severity: log.severity,
      createdAt: log.createdAt,
    }));

    res.json({
      activeVehicles,
      totalVehicles,
      pmsDueVehicles,
      pmsApproaching,
      pmsAlerts: pmsDueVehicles,
      pendingPrs: pendingPrCount,
      pendingPrTotalValue,
      openTsrfCount: totalOpenTsrfCount,
      dispatchedCount: dispatchedTsrfCount,
      recentActivity,
    });
  } catch (err: unknown) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});
