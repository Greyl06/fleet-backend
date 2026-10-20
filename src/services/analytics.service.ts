import { eq, desc } from 'drizzle-orm';
import { db } from '../db/connection.js';
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

export class AnalyticsService {
  /**
   * Compiles complete fleet-wide TCO and Cost-per-Kilometer analytics
   */
  static async getFleetTcoAnalytics(): Promise<FleetTcoSummary> {
    // 1. Fetch all vehicles
    const vehicleRows = await db.select().from(vehicles);

    // 2. Fetch all repair work orders
    const workOrderRows = await db.select().from(repairWorkOrders);

    // 3. Fetch all PRs
    const prRows = await db.select().from(purchaseRequisitions);
    const prMap = new Map(prRows.map((pr) => [pr.id, pr]));

    // 4. Fetch all PMS records
    const pmsRows = await db.select().from(pmsRecords);

    // 5. Fetch TSRF requests for department mapping
    const tsrfRows = await db.select().from(tsrfRequests);
    const vehicleDeptMap = new Map<string, string>();
    for (const tsrf of tsrfRows) {
      if (tsrf.assignedVehicleId && tsrf.department) {
        vehicleDeptMap.set(tsrf.assignedVehicleId, tsrf.department);
      }
    }

    // 6. Aggregate spend per vehicle
    const vehicleSpendMap = new Map<
      string,
      {
        repairSpend: number;
        pmsSpend: number;
        workOrderCount: number;
        pmsCompletedCount: number;
      }
    >();

    // Initialize map
    for (const v of vehicleRows) {
      vehicleSpendMap.set(v.id, {
        repairSpend: 0,
        pmsSpend: 0,
        workOrderCount: 0,
        pmsCompletedCount: 0,
      });
    }

    const monthlyEvents: { date: Date; amount: number; isPms: boolean }[] = [];

    // Tally repair work orders
    for (const wo of workOrderRows) {
      const stats = vehicleSpendMap.get(wo.vehicleId);
      if (!stats) continue;

      stats.workOrderCount += 1;

      let cost = 0;
      if (wo.linkedPrId) {
        const pr = prMap.get(wo.linkedPrId);
        if (pr && (pr.status === 'approved' || wo.status === 'completed' || wo.status === 'in_progress')) {
          cost = pr.amount || 0;
        }
      }

      // Default minimal diagnostic/repair cost if unlinked work order exists
      if (cost === 0 && (wo.status === 'completed' || wo.status === 'in_progress')) {
        cost = 3500;
      }

      stats.repairSpend += cost;

      if (cost > 0) {
        monthlyEvents.push({
          date: wo.createdAt,
          amount: cost,
          isPms: false,
        });
      }
    }

    // Tally PMS records
    const standardPmsPackageRate = 4500; // Standard Hulma PMS service package rate in PHP
    for (const pms of pmsRows) {
      const stats = vehicleSpendMap.get(pms.vehicleId);
      if (!stats) continue;

      if (pms.status === 'completed') {
        stats.pmsCompletedCount += 1;
        stats.pmsSpend += standardPmsPackageRate;
        monthlyEvents.push({
          date: pms.completedAt || pms.createdAt,
          amount: standardPmsPackageRate,
          isPms: true,
        });
      }
    }

    // 7. Format input for domain calculation
    const vehicleDataList: VehicleCostData[] = vehicleRows.map((v) => {
      const stats = vehicleSpendMap.get(v.id) || {
        repairSpend: 0,
        pmsSpend: 0,
        workOrderCount: 0,
        pmsCompletedCount: 0,
      };

      return {
        vehicleId: v.id,
        plateNumber: v.plateNumber,
        model: v.model,
        vehicleType: v.vehicleType,
        assignedDriver: v.assignedDriver,
        currentKm: v.currentKm,
        lastPmsKm: v.lastPmsKm,
        status: v.status,
        repairSpend: stats.repairSpend,
        pmsSpend: stats.pmsSpend,
        workOrderCount: stats.workOrderCount,
        pmsCompletedCount: stats.pmsCompletedCount,
        department: vehicleDeptMap.get(v.id) || 'Fleet Operations',
      };
    });

    logger.info(
      { vehicleCount: vehicleRows.length, eventCount: monthlyEvents.length },
      '[AnalyticsService] Computed Fleet TCO Analytics',
    );

    return computeFleetTcoAnalysis(vehicleDataList, monthlyEvents);
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

    const prRows = await db.select().from(purchaseRequisitions);
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
