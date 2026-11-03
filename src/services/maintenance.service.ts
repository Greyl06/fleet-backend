import { and, eq, desc, ne } from 'drizzle-orm';
import { db } from '../db/connection.js';
import {
  pmsRecords,
  repairWorkOrders,
  incidentReports,
  vehicles,
  purchaseRequisitions,
} from '../db/schema.js';
import { isPmsOverdue } from '../domain/pms.js';
import { assertPrApproved } from '../domain/prGating.js';
import { logger } from '../config/logger.js';
import type { OffsetPage } from '../routes/pagination.js';
import type { AuthUser } from '../auth/abilities.js';
import type { PurchaseRequisitionScope } from '../auth/scope.js';
import { ConflictError, NotFoundError, ValidationError } from '../http/errors.js';
import { purchaseRequisitionScopeCondition } from './procurement.service.js';
import { nextDocumentNumber } from '../db/document-numbers.js';

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** A PR funds exactly one repair work order; reuse would let one approval unlock many repairs. */
async function assertPrNotLinkedElsewhere(
  executor: Transaction | typeof db,
  prId: string,
  workOrderId?: string,
): Promise<void> {
  const [other] = await executor
    .select({ id: repairWorkOrders.id })
    .from(repairWorkOrders)
    .where(
      workOrderId
        ? and(eq(repairWorkOrders.linkedPrId, prId), ne(repairWorkOrders.id, workOrderId))
        : eq(repairWorkOrders.linkedPrId, prId),
    )
    .limit(1);
  if (other) {
    throw new ConflictError('Purchase requisition is already linked to another work order.');
  }
}

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
    if (!pms) throw new NotFoundError('PMS record not found.');

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

  static async listPmsRecords(vehicleId: string | undefined, page: OffsetPage) {
    const rows = await (vehicleId
      ? db
        .select()
        .from(pmsRecords)
        .where(eq(pmsRecords.vehicleId, vehicleId))
        .orderBy(desc(pmsRecords.createdAt), desc(pmsRecords.id))
      : db
          .select()
          .from(pmsRecords)
          .orderBy(desc(pmsRecords.createdAt), desc(pmsRecords.id)))
      .limit(page.limit + 1)
      .offset(page.offset);
    return {
      items: rows.slice(0, page.limit),
      hasMore: rows.length > page.limit,
    };
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
    if (!vehicle) throw new NotFoundError('Vehicle not found.');

    if (data.linkedPrId) {
      const [pr] = await db
        .select({ id: purchaseRequisitions.id })
        .from(purchaseRequisitions)
        .where(eq(purchaseRequisitions.id, data.linkedPrId));
      if (!pr) throw new ValidationError('Linked purchase requisition does not exist.');
      await assertPrNotLinkedElsewhere(db, data.linkedPrId);
    }

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

    const workOrderNumber = await nextDocumentNumber('WO');

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

  static async listRepairWorkOrders(page: OffsetPage) {
    const rows = await db
      .select()
      .from(repairWorkOrders)
      .orderBy(desc(repairWorkOrders.createdAt), desc(repairWorkOrders.id))
      .limit(page.limit + 1)
      .offset(page.offset);
    return {
      items: rows.slice(0, page.limit),
      hasMore: rows.length > page.limit,
    };
  }

  static async getRepairWorkOrderById(id: string) {
    const [order] = await db.select().from(repairWorkOrders).where(eq(repairWorkOrders.id, id));
    return order || null;
  }

  // ----------------------------------------------------
  // Incident Report Operations (Mandatory for skipped PMS)
  // ----------------------------------------------------
  /**
   * Files the incident report and flags the work order in one transaction.
   * The reporter is the authenticated user, and the work order must belong to
   * the stated vehicle and still be pending.
   */
  static async fileIncidentReport(
    data: {
      vehicleId: string;
      repairWorkOrderId: string;
      incidentDate: Date;
      reason: string;
      damagesDescription: string;
      preventativeAction?: string;
    },
    reporter: AuthUser,
  ) {
    return db.transaction(async (tx) => {
      const [order] = await tx
        .select({
          id: repairWorkOrders.id,
          vehicleId: repairWorkOrders.vehicleId,
          status: repairWorkOrders.status,
          incidentReportFiled: repairWorkOrders.incidentReportFiled,
        })
        .from(repairWorkOrders)
        .where(eq(repairWorkOrders.id, data.repairWorkOrderId))
        .for('update');

      if (!order) throw new NotFoundError('Repair work order not found.');
      if (order.vehicleId !== data.vehicleId) {
        throw new ValidationError('The repair work order does not belong to the specified vehicle.');
      }
      if (order.incidentReportFiled) {
        throw new ConflictError('An incident report has already been filed for this work order.');
      }
      if (order.status !== 'pending') {
        throw new ConflictError(
          `Incident reports can only be filed for pending work orders; this one is ${order.status}.`,
        );
      }

      const [incident] = await tx
        .insert(incidentReports)
        .values({
          vehicleId: data.vehicleId,
          repairWorkOrderId: data.repairWorkOrderId,
          reportedBy: reporter.name,
          incidentDate: data.incidentDate,
          reason: data.reason,
          damagesDescription: data.damagesDescription,
          preventativeAction: data.preventativeAction || null,
        })
        .returning();

      await tx
        .update(repairWorkOrders)
        .set({ incidentReportFiled: true })
        .where(eq(repairWorkOrders.id, data.repairWorkOrderId));

      logger.info(
        { incidentId: incident.id, workOrderId: data.repairWorkOrderId, reporterId: reporter.id },
        '[MaintenanceService] Mandatory Incident Report filed',
      );

      return incident;
    });
  }

  // ----------------------------------------------------
  // PR Gatekeeper Unlock
  // ----------------------------------------------------
  /**
   * Unlocks a pending work order using its own linked PR. A caller-supplied PR
   * is accepted only when it matches the existing link, or when the order has
   * no link yet and the PR is in the caller's scope and unused elsewhere.
   * Rows are locked so concurrent unlocks cannot reuse a PR or double-apply.
   */
  static async unlockWorkOrderWithPr(
    workOrderId: string,
    requestedPrId: string | undefined,
    scope: PurchaseRequisitionScope,
  ) {
    return db.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(repairWorkOrders)
        .where(eq(repairWorkOrders.id, workOrderId))
        .for('update');
      if (!order) throw new NotFoundError('Work order not found.');

      if (requestedPrId && order.linkedPrId && requestedPrId !== order.linkedPrId) {
        throw new ConflictError('Work order is linked to a different purchase requisition.');
      }
      const effectivePrId = order.linkedPrId ?? requestedPrId;
      if (!effectivePrId) {
        throw new ValidationError('Cannot unlock work order: No Purchase Requisition linked.');
      }

      if (order.status === 'approved' && order.linkedPrId === effectivePrId) {
        return order;
      }
      if (order.status !== 'pending') {
        throw new ConflictError(`Work order is ${order.status} and cannot be unlocked.`);
      }

      const [pr] = await tx
        .select({
          id: purchaseRequisitions.id,
          prNumber: purchaseRequisitions.prNumber,
          status: purchaseRequisitions.status,
        })
        .from(purchaseRequisitions)
        .where(
          and(
            eq(purchaseRequisitions.id, effectivePrId),
            purchaseRequisitionScopeCondition(scope),
          ),
        )
        .for('update');
      if (!pr) throw new NotFoundError('Linked purchase requisition not found.');

      await assertPrNotLinkedElsewhere(tx, effectivePrId, workOrderId);

      // Reference Domain Rule 4: Centralized PR Gatekeeper check
      assertPrApproved(pr.status);

      const [unlocked] = await tx
        .update(repairWorkOrders)
        .set({
          linkedPrId: effectivePrId,
          status: 'approved',
          procurementFulfillmentStatus: 'pr_approved',
        })
        .where(and(eq(repairWorkOrders.id, workOrderId), eq(repairWorkOrders.status, 'pending')))
        .returning();
      if (!unlocked) throw new ConflictError('Work order changed while it was being unlocked.');

      logger.info(
        { workOrderId, prNumber: pr.prNumber },
        '[MaintenanceService] Work order successfully unlocked via approved PR Gatekeeper',
      );

      return unlocked;
    });
  }
}
