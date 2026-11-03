import { and, eq, desc, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  purchaseRequisitions,
  repairWorkOrders,
  vehicles,
} from "../db/schema.js";
import { logger } from "../config/logger.js";
import type { OffsetPage } from "../routes/pagination.js";
import type { AuthUser } from "../auth/abilities.js";
import type { PurchaseRequisitionScope } from "../auth/scope.js";
import { ConflictError, NotFoundError } from "../http/errors.js";
import { nextDocumentNumber } from "../db/document-numbers.js";

export function purchaseRequisitionScopeCondition(
  scope: PurchaseRequisitionScope,
): SQL | undefined {
  if (scope.kind === "all") return undefined;
  if (scope.kind === "none") return sql`false`;
  return sql`lower(btrim(${purchaseRequisitions.department})) = ${scope.department}`;
}

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
    const prNumber = await nextDocumentNumber("PR");

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

  static async listPrs(page: OffsetPage, scope: PurchaseRequisitionScope) {
    const rows = await db
      .select()
      .from(purchaseRequisitions)
      .where(purchaseRequisitionScopeCondition(scope))
      .orderBy(desc(purchaseRequisitions.createdAt), desc(purchaseRequisitions.id))
      .limit(page.limit + 1)
      .offset(page.offset);
    return {
      items: rows.slice(0, page.limit),
      hasMore: rows.length > page.limit,
    };
  }

  static async getPrById(id: string, scope: PurchaseRequisitionScope) {
    const [pr] = await db
      .select()
      .from(purchaseRequisitions)
      .where(
        and(
          eq(purchaseRequisitions.id, id),
          purchaseRequisitionScopeCondition(scope),
        ),
      );
    return pr || null;
  }

  /**
   * Approves a PR only while it is still pending and inside the approver's
   * scope. The status guard lives in the UPDATE itself, so concurrent or
   * replayed approvals cannot overwrite an earlier decision.
   */
  static async approvePr(
    id: string,
    approver: AuthUser,
    scope: PurchaseRequisitionScope,
  ) {
    const [updated] = await db
      .update(purchaseRequisitions)
      .set({
        status: "approved",
        approvedBy: approver.name,
        approvedAt: new Date(),
      })
      .where(
        and(
          eq(purchaseRequisitions.id, id),
          eq(purchaseRequisitions.status, "pending"),
          purchaseRequisitionScopeCondition(scope),
        ),
      )
      .returning();

    if (!updated) {
      // Out-of-scope PRs are reported as missing so their existence is not disclosed.
      const existing = await this.getPrById(id, scope);
      if (!existing) throw new NotFoundError("Purchase requisition not found.");
      throw new ConflictError(
        `Purchase requisition ${existing.prNumber} is ${existing.status} and can no longer be approved.`,
      );
    }

    logger.info(
      { prId: id, approverId: approver.id, approverRole: approver.role },
      "[ProcurementService] PR approved",
    );
    return updated;
  }

  // ----------------------------------------------------
  // Procurement Order Fulfillment
  // ----------------------------------------------------
  static async listProcurementWorkOrders(page: OffsetPage) {
    const rows = await db
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
      .orderBy(desc(repairWorkOrders.createdAt), desc(repairWorkOrders.id))
      .limit(page.limit + 1)
      .offset(page.offset);
    return {
      items: rows.slice(0, page.limit),
      hasMore: rows.length > page.limit,
    };
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
