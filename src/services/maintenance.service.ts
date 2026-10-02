import { eq, desc } from 'drizzle-orm';
import { db } from '../db/connection.js';
import {
  pmsRecords,
  repairWorkOrders,
  incidentReports,
  vehicles,
  purchaseRequisitions,
} from '../db/schema.js';
import { isPmsOverdue } from '../domain/pms.js';
import { validateRepairApproval } from '../domain/repair.js';
import { assertPrApproved } from '../domain/prGating.js';
import { logger } from '../config/logger.js';

export class MaintenanceService {
  // ----------------------------------------------------
  // PMS Operations
  // ----------------------------------------------------
  static async schedulePmsOrder(data: { vehicleId: string; pmsKm: number; notes?: string }) {
    const [pms] = await db
      .insert(pmsRecords)
      .values({
        vehicleId: data.vehicleId,
        pmsKm: data.pmsKm,
        status: 'scheduled',
        notes: data.notes || null,
      })
      .returning();

    return pms;
  }

  static async completePmsOrder(pmsId: string, actualKm: number) {
    const [pms] = await db.select().from(pmsRecords).where(eq(pmsRecords.id, pmsId));
    if (!pms) throw new Error(`PMS record ${pmsId} not found`);

    const [updatedPms] = await db
      .update(pmsRecords)
      .set({
        status: 'completed',
        completedAt: new Date(),
      })
      .where(eq(pmsRecords.id, pmsId))
      .returning();

    // Update vehicle's lastPmsKm and reset status to active
    await db
      .update(vehicles)
      .set({
        lastPmsKm: actualKm,
        status: 'active',
        updatedAt: new Date(),
      })
      .where(eq(vehicles.id, pms.vehicleId));

    logger.info(
      { pmsId, vehicleId: pms.vehicleId, actualKm },
      '[MaintenanceService] PMS completed & vehicle status reset to active',
    );

    return updatedPms;
  }

  static async listPmsRecords(vehicleId?: string) {
    if (vehicleId) {
      return db
        .select()
        .from(pmsRecords)
        .where(eq(pmsRecords.vehicleId, vehicleId))
        .orderBy(desc(pmsRecords.createdAt));
    }
    return db.select().from(pmsRecords).orderBy(desc(pmsRecords.createdAt));
  }

  // ----------------------------------------------------
  // Repair Work Order Operations
  // ----------------------------------------------------
  static async createRepairWorkOrder(data: {
    vehicleId: string;
    description: string;
    linkedPrId?: string;
  }) {
    const [vehicle] = await db.select().from(vehicles).where(eq(vehicles.id, data.vehicleId));
    if (!vehicle) throw new Error(`Vehicle ${data.vehicleId} not found`);

    // Check if vehicle has any skipped PMS
    const pastPms = await db
      .select()
      .from(pmsRecords)
      .where(eq(pmsRecords.vehicleId, data.vehicleId))
      .orderBy(desc(pmsRecords.createdAt));

    const wasPmsSkipped = pastPms.some((p) => p.status === 'skipped');
    const isOverdue = isPmsOverdue({
      currentKm: vehicle.currentKm,
      lastCompletedPmsKm: vehicle.lastPmsKm,
      intervalKm: vehicle.pmsIntervalKm,
    });

    const isPmsCompliant = !isOverdue && !wasPmsSkipped;

    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const workOrderNumber = `WO-${new Date().getFullYear()}-${randomSuffix}`;

    const [order] = await db
      .insert(repairWorkOrders)
      .values({
        workOrderNumber,
        vehicleId: data.vehicleId,
        description: data.description,
        status: 'pending',
        linkedPrId: data.linkedPrId || null,
        hasPmsCompliance: isPmsCompliant,
        incidentReportFiled: false,
        procurementFulfillmentStatus: 'pending_pr_approval',
      })
      .returning();

    // Mark vehicle as in_maintenance
    await db
      .update(vehicles)
      .set({ status: 'in_maintenance', updatedAt: new Date() })
      .where(eq(vehicles.id, data.vehicleId));

    logger.info(
      {
        workOrderId: order.id,
        workOrderNumber: order.workOrderNumber,
        isPmsCompliant,
        wasPmsSkipped,
      },
      '[MaintenanceService] Repair work order created',
    );

    return {
      order,
      isPmsCompliant,
      wasPmsSkipped,
      requiresIncidentReport: wasPmsSkipped,
    };
  }

  static async listRepairWorkOrders() {
    return db.select().from(repairWorkOrders).orderBy(desc(repairWorkOrders.createdAt));
  }

  static async getRepairWorkOrderById(id: string) {
    const [order] = await db.select().from(repairWorkOrders).where(eq(repairWorkOrders.id, id));
    return order || null;
  }

  // ----------------------------------------------------
  // Incident Report Operations (Mandatory for skipped PMS)
  // ----------------------------------------------------
  static async fileIncidentReport(data: {
    vehicleId: string;
    repairWorkOrderId: string;
    reportedBy: string;
    incidentDate: string | Date;
    reason: string;
    damagesDescription: string;
    preventativeAction?: string;
  }) {
    const [incident] = await db
      .insert(incidentReports)
      .values({
        vehicleId: data.vehicleId,
        repairWorkOrderId: data.repairWorkOrderId,
        reportedBy: data.reportedBy,
        incidentDate: new Date(data.incidentDate),
        reason: data.reason,
        damagesDescription: data.damagesDescription,
        preventativeAction: data.preventativeAction || null,
      })
      .returning();

    // Automatically set incidentReportFiled to TRUE on the repair work order
    await db
      .update(repairWorkOrders)
      .set({ incidentReportFiled: true })
      .where(eq(repairWorkOrders.id, data.repairWorkOrderId));

    logger.info(
      { incidentId: incident.id, workOrderId: data.repairWorkOrderId },
      '[MaintenanceService] Mandatory Incident Report filed & unlocked for repair audit',
    );

    return incident;
  }

  // ----------------------------------------------------
  // PR Gatekeeper Unlock
  // ----------------------------------------------------
  static async unlockWorkOrderWithPr(workOrderId: string, prId?: string) {
    const order = await this.getRepairWorkOrderById(workOrderId);
    if (!order) throw new Error(`Work order ${workOrderId} not found`);

    const effectivePrId = prId || order.linkedPrId;
    if (!effectivePrId) {
      throw new Error('Cannot unlock work order: No Purchase Requisition linked.');
    }

    const [pr] = await db
      .select()
      .from(purchaseRequisitions)
      .where(eq(purchaseRequisitions.id, effectivePrId));

    if (!pr) {
      throw new Error(`Linked Purchase Requisition ${effectivePrId} not found.`);
    }

    // Reference Domain Rule 4: Centralized PR Gatekeeper check
    assertPrApproved(pr.status);

    const [unlocked] = await db
      .update(repairWorkOrders)
      .set({
        linkedPrId: effectivePrId,
        status: 'approved',
        procurementFulfillmentStatus: 'pr_approved',
      })
      .where(eq(repairWorkOrders.id, workOrderId))
      .returning();

    logger.info(
      { workOrderId, prNumber: pr.prNumber },
      '[MaintenanceService] Work order successfully unlocked via approved PR Gatekeeper',
    );

    return unlocked;
  }
}
