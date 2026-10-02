import { and, eq, desc, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  purchaseRequisitions,
  repairWorkOrders,
  vehicles,
} from "../db/schema.js";
import { logger } from "../config/logger.js";

export class WorkOrderNotFoundError extends Error {
  constructor(workOrderId: string) {
    super(`Work order ${workOrderId} not found`);
    this.name = "WorkOrderNotFoundError";
  }
}

export class InvalidFulfillmentTransitionError extends Error {
  constructor(currentStatus: string, requestedStatus: string) {
    super(
      `Cannot move fulfillment from '${currentStatus}' to '${requestedStatus}'.`,
    );
    this.name = "InvalidFulfillmentTransitionError";
  }
}

export class ProcurementService {
  // ----------------------------------------------------
  // PR Management
  // ----------------------------------------------------
  static async createPr(data: {
    department: string;
    purpose: string;
    amount?: number;
  }) {
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const prNumber = `PR-${new Date().getFullYear()}-${randomSuffix}`;

    const [pr] = await db
      .insert(purchaseRequisitions)
      .values({
        prNumber,
        department: data.department,
        purpose: data.purpose,
        amount: data.amount ?? 0,
        status: "pending",
      })
      .returning();

    logger.info(
      { prId: pr.id, prNumber: pr.prNumber },
      "[ProcurementService] PR created",
    );
    return pr;
  }

  static async listPrs() {
    return db
      .select()
      .from(purchaseRequisitions)
      .orderBy(desc(purchaseRequisitions.createdAt));
  }

  static async getPrById(id: string) {
    const [pr] = await db
      .select()
      .from(purchaseRequisitions)
      .where(eq(purchaseRequisitions.id, id));
    return pr || null;
  }

  static async approvePr(id: string, approverName = "Finance Manager") {
    const [updated] = await db
      .update(purchaseRequisitions)
      .set({
        status: "approved",
        approvedBy: approverName,
        approvedAt: new Date(),
      })
      .where(eq(purchaseRequisitions.id, id))
      .returning();

    if (!updated) throw new Error(`PR ${id} not found`);

    logger.info(
      { prId: id, approverName },
      "[ProcurementService] PR approved by Finance",
    );
    return updated;
  }

  // ----------------------------------------------------
  // Procurement Order Fulfillment
  // ----------------------------------------------------
  static async listProcurementWorkOrders() {
    return db
      .select()
      .from(repairWorkOrders)
      .where(
        inArray(repairWorkOrders.procurementFulfillmentStatus, [
          "pr_approved",
          "in_maintenance",
          "work_completed",
          "vehicle_operational",
        ]),
      )
      .orderBy(desc(repairWorkOrders.createdAt));
  }

  static async updateFulfillmentStatus(
    workOrderId: string,
    status: "in_maintenance" | "work_completed" | "vehicle_operational",
    _notes?: string,
  ) {
    const expectedStatus = {
      in_maintenance: "pr_approved",
      work_completed: "in_maintenance",
      vehicle_operational: "work_completed",
    }[status];

    return db.transaction(async (transaction) => {
      const [order] = await transaction
        .select()
        .from(repairWorkOrders)
        .where(eq(repairWorkOrders.id, workOrderId));

      if (!order) throw new WorkOrderNotFoundError(workOrderId);
      if (order.procurementFulfillmentStatus !== expectedStatus) {
        throw new InvalidFulfillmentTransitionError(
          order.procurementFulfillmentStatus,
          status,
        );
      }

      const [updatedOrder] = await transaction
        .update(repairWorkOrders)
        .set({
          procurementFulfillmentStatus: status,
          status:
            status === "work_completed" || status === "vehicle_operational"
              ? "completed"
              : "in_progress",
        })
        .where(
          and(
            eq(repairWorkOrders.id, workOrderId),
            eq(repairWorkOrders.procurementFulfillmentStatus, expectedStatus),
          ),
        )
        .returning();

      if (!updatedOrder) {
        throw new InvalidFulfillmentTransitionError(
          order.procurementFulfillmentStatus,
          status,
        );
      }

      if (status === "vehicle_operational") {
        await transaction
          .update(vehicles)
          .set({ status: "active", updatedAt: new Date() })
          .where(eq(vehicles.id, order.vehicleId));

        logger.info(
          { vehicleId: order.vehicleId, workOrderId },
          "[ProcurementService] Vehicle released back to operational service",
        );
      }

      return updatedOrder;
    });
  }
}
