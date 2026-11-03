import { eq, desc, inArray } from 'drizzle-orm';
import { db, pool } from '../db/connection.js';
import {
  vehicles,
  repairWorkOrders,
  purchaseRequisitions,
  pmsRecords,
  tsrfRequests,
} from '../db/schema.js';
import {
  computeFleetTcoAnalysis,
  type FleetTcoSummary,
  type VehicleCostData,
} from '../domain/tco.js';
import { logger } from '../config/logger.js';

interface FleetAggregateRow {
  id: string;
  plate_number: string;
  model: string;
  vehicle_type: string;
  assigned_driver: string | null;
  current_km: number;
  last_pms_km: number;
  status: string;
  repair_spend: string | number;
  pms_spend: string | number;
  work_order_count: string | number;
  pms_completed_count: string | number;
  department: string;
}

interface MonthlyAggregateRow {
  month: Date;
  repair_spend: string | number;
  pms_spend: string | number;
  event_count: string | number;
}

export class AnalyticsService {
  /**
   * Compiles complete fleet-wide TCO and Cost-per-Kilometer analytics
   */
  static async getFleetTcoAnalytics(): Promise<FleetTcoSummary> {
    const trendStart = new Date();
    trendStart.setDate(1);
    trendStart.setHours(0, 0, 0, 0);
    trendStart.setMonth(trendStart.getMonth() - 5);
    const [fleetResult, monthlyResult] = await Promise.all([
      pool.query<FleetAggregateRow>(`
        WITH repair_totals AS (
          SELECT
            wo.vehicle_id,
            COUNT(*) AS work_order_count,
            SUM(
              CASE
                WHEN wo.linked_pr_id IS NOT NULL
                  AND (pr.status = 'approved' OR wo.status IN ('completed', 'in_progress'))
                  AND COALESCE(pr.amount, 0) <> 0
                  THEN pr.amount
                WHEN wo.status IN ('completed', 'in_progress') THEN 3500
                ELSE 0
              END
            ) AS repair_spend
          FROM repair_work_orders wo
          LEFT JOIN purchase_requisitions pr ON pr.id = wo.linked_pr_id
          GROUP BY wo.vehicle_id
        ),
        pms_totals AS (
          SELECT
            vehicle_id,
            COUNT(*) FILTER (WHERE status = 'completed') AS pms_completed_count
          FROM pms_records
          GROUP BY vehicle_id
        ),
        latest_department AS (
          SELECT DISTINCT ON (assigned_vehicle_id)
            assigned_vehicle_id,
            department
          FROM tsrf_requests
          WHERE assigned_vehicle_id IS NOT NULL
          ORDER BY assigned_vehicle_id, created_at DESC, id DESC
        )
        SELECT
          v.id,
          v.plate_number,
          v.model,
          v.vehicle_type,
          v.assigned_driver,
          v.current_km,
          v.last_pms_km,
          v.status,
          COALESCE(r.repair_spend, 0) AS repair_spend,
          COALESCE(p.pms_completed_count, 0) * 4500 AS pms_spend,
          COALESCE(r.work_order_count, 0) AS work_order_count,
          COALESCE(p.pms_completed_count, 0) AS pms_completed_count,
          COALESCE(d.department, 'Fleet Operations') AS department
        FROM vehicles v
        LEFT JOIN repair_totals r ON r.vehicle_id = v.id
        LEFT JOIN pms_totals p ON p.vehicle_id = v.id
        LEFT JOIN latest_department d ON d.assigned_vehicle_id = v.id
      `),
      pool.query<MonthlyAggregateRow>(
        `
          WITH work_order_costs AS (
            SELECT
              wo.created_at,
              CASE
                WHEN wo.linked_pr_id IS NOT NULL
                  AND (pr.status = 'approved' OR wo.status IN ('completed', 'in_progress'))
                  AND COALESCE(pr.amount, 0) <> 0
                  THEN pr.amount
                WHEN wo.status IN ('completed', 'in_progress') THEN 3500
                ELSE 0
              END AS cost
            FROM repair_work_orders wo
            LEFT JOIN purchase_requisitions pr ON pr.id = wo.linked_pr_id
            WHERE wo.created_at >= $1
          )
          SELECT
            date_trunc('month', created_at) AS month,
            SUM(cost) AS repair_spend,
            0::bigint AS pms_spend,
            COUNT(*) FILTER (WHERE cost > 0) AS event_count
          FROM work_order_costs
          GROUP BY 1
          UNION ALL
          SELECT
            date_trunc('month', COALESCE(completed_at, created_at)) AS month,
            0::bigint AS repair_spend,
            COUNT(*) * 4500 AS pms_spend,
            COUNT(*) AS event_count
          FROM pms_records
          WHERE status = 'completed'
            AND (
              completed_at >= $1
              OR (completed_at IS NULL AND created_at >= $1)
            )
          GROUP BY 1
        `,
        [trendStart],
      ),
    ]);

    const vehicleDataList: VehicleCostData[] = fleetResult.rows.map((row) => ({
      vehicleId: row.id,
      plateNumber: row.plate_number,
      model: row.model,
      vehicleType: row.vehicle_type,
      assignedDriver: row.assigned_driver,
      currentKm: row.current_km,
      lastPmsKm: row.last_pms_km,
      status: row.status,
      repairSpend: Number(row.repair_spend),
      pmsSpend: Number(row.pms_spend),
      workOrderCount: Number(row.work_order_count),
      pmsCompletedCount: Number(row.pms_completed_count),
      department: row.department,
    }));
    const monthlyEvents: { date: Date; amount: number; isPms: boolean }[] = [];
    const monthlyEventCounts = new Map<string, number>();
    for (const row of monthlyResult.rows) {
      const monthKey = `${row.month.getFullYear()}-${String(
        row.month.getMonth() + 1,
      ).padStart(2, "0")}`;
      const eventCount = Number(row.event_count);
      monthlyEventCounts.set(
        monthKey,
        (monthlyEventCounts.get(monthKey) ?? 0) + eventCount,
      );
      const repairSpend = Number(row.repair_spend);
      const pmsSpend = Number(row.pms_spend);
      if (repairSpend > 0) {
        monthlyEvents.push({ date: row.month, amount: repairSpend, isPms: false });
      }
      if (pmsSpend > 0) {
        monthlyEvents.push({ date: row.month, amount: pmsSpend, isPms: true });
      }
    }

    logger.info(
      {
        vehicleCount: vehicleDataList.length,
        monthCount: monthlyEventCounts.size,
      },
      '[AnalyticsService] Computed Fleet TCO Analytics',
    );

    return computeFleetTcoAnalysis(
      vehicleDataList,
      monthlyEvents,
      monthlyEventCounts,
    );
  }

  /**
   * Retrieves single-vehicle TCO detailed breakdown with repair timeline
   */
  static async getVehicleTcoDetail(vehicleId: string) {
    const [v] = await db.select().from(vehicles).where(eq(vehicles.id, vehicleId));
    if (!v) return null;

    const workOrders = await db
      .select()
      .from(repairWorkOrders)
      .where(eq(repairWorkOrders.vehicleId, vehicleId))
      .orderBy(desc(repairWorkOrders.createdAt));

    const pmsHistory = await db
      .select()
      .from(pmsRecords)
      .where(eq(pmsRecords.vehicleId, vehicleId))
      .orderBy(desc(pmsRecords.createdAt));

    const prIds = Array.from(
      new Set(
        workOrders
          .map((workOrder) => workOrder.linkedPrId)
          .filter((id): id is string => id !== null),
      ),
    );
    const prRows = prIds.length
      ? await db
          .select({
            id: purchaseRequisitions.id,
            amount: purchaseRequisitions.amount,
            prNumber: purchaseRequisitions.prNumber,
            status: purchaseRequisitions.status,
          })
          .from(purchaseRequisitions)
          .where(inArray(purchaseRequisitions.id, prIds))
      : [];
    const prMap = new Map(prRows.map((p) => [p.id, p]));

    let totalRepairSpend = 0;
    const enrichedWorkOrders = workOrders.map((wo) => {
      const pr = wo.linkedPrId ? prMap.get(wo.linkedPrId) : null;
      const spend = pr?.amount || (wo.status === 'completed' ? 3500 : 0);
      totalRepairSpend += spend;
      return {
        ...wo,
        cost: spend,
        prNumber: pr?.prNumber || null,
        prStatus: pr?.status || null,
      };
    });

    const standardPmsPackageRate = 4500;
    const completedPmsCount = pmsHistory.filter((p) => p.status === 'completed').length;
    const totalPmsSpend = completedPmsCount * standardPmsPackageRate;
    const totalMaintenanceSpend = totalRepairSpend + totalPmsSpend;
    const costPerKm = v.currentKm > 0 ? Math.round((totalMaintenanceSpend / v.currentKm) * 100) / 100 : 0;

    return {
      vehicle: v,
      costSummary: {
        currentKm: v.currentKm,
        totalRepairSpend,
        totalPmsSpend,
        totalMaintenanceSpend,
        costPerKm,
        workOrderCount: workOrders.length,
        completedPmsCount,
      },
      workOrders: enrichedWorkOrders,
      pmsHistory,
    };
  }
}
