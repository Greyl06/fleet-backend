import { eq, desc } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { tsrfRequests } from '../db/schema.js';
import { evaluateTsrfSubmissionTime } from '../domain/tsrf.js';
import { VehicleService } from './vehicle.service.js';
import { logger } from '../config/logger.js';

export interface CreateTsrfInput {
  department: string;
  projectName: string;
  origin: string;
  destination: string;
  stops?: Array<{
    stopOrder: number;
    locationName: string;
    address: string;
    arrivalTime?: string;
    departureTime?: string;
    waitingTimeMinutes?: number;
    notes?: string;
  }>;
  passengers?: Array<{
    name: string;
    department: string;
    role?: string;
    contactNumber?: string;
  }>;
  cargo?: Array<{
    description: string;
    quantity?: number;
    weightKg?: number;
    isFragile?: boolean;
  }>;
  vehicleType?: string;
  assignedVehicleId?: string;
  assignedDriver?: string;
  departureDate: string | Date;
  callTime: string;
  submissionDate?: Date;
}

export class TsrfService {
  static async createTsrf(input: CreateTsrfInput) {
    const submissionDate = input.submissionDate ?? new Date();
    const cutoffEval = evaluateTsrfSubmissionTime(submissionDate);

    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const requestNumber = `TSRF-${new Date().getFullYear()}-${randomSuffix}`;

    const [created] = await db
      .insert(tsrfRequests)
      .values({
        requestNumber,
        department: input.department,
        projectName: input.projectName,
        origin: input.origin,
        destination: input.destination,
        stopsJson: JSON.stringify(input.stops ?? []),
        passengersJson: JSON.stringify(input.passengers ?? []),
        cargoJson: JSON.stringify(input.cargo ?? []),
        vehicleType: input.vehicleType ?? 'commuter_van',
        assignedVehicleId: input.assignedVehicleId || null,
        assignedDriver: input.assignedDriver || null,
        departureDate: new Date(input.departureDate),
        callTime: input.callTime,
        isFlaggedAfterCutoff: cutoffEval.isFlaggedAfterCutoff,
        cutoffReason: cutoffEval.reason || null,
        approvalStatus: 'pending',
        tripStatus: 'requested',
      })
      .returning();

    logger.info(
      {
        requestId: created.id,
        requestNumber: created.requestNumber,
        isFlaggedAfterCutoff: created.isFlaggedAfterCutoff,
      },
      '[TsrfService] TSRF request created',
    );

    return created;
  }

  static async listTsrf(filters?: { department?: string; approvalStatus?: string }) {
    let query = db.select().from(tsrfRequests).orderBy(desc(tsrfRequests.createdAt));
    const results = await query;
    return results.map((r) => ({
      ...r,
      stops: JSON.parse(r.stopsJson || '[]'),
      passengers: JSON.parse(r.passengersJson || '[]'),
      cargo: JSON.parse(r.cargoJson || '[]'),
    }));
  }

  static async getTsrfById(id: string) {
    const [r] = await db.select().from(tsrfRequests).where(eq(tsrfRequests.id, id));
    if (!r) return null;
    return {
      ...r,
      stops: JSON.parse(r.stopsJson || '[]'),
      passengers: JSON.parse(r.passengersJson || '[]'),
      cargo: JSON.parse(r.cargoJson || '[]'),
    };
  }

  static async endorseTsrf(
    id: string,
    role: 'department_head' | 'logistics_head' | 'finance_manager',
    action: 'approve' | 'reject',
  ) {
    const tsrf = await this.getTsrfById(id);
    if (!tsrf) throw new Error(`TSRF with ID ${id} not found`);

    if (action === 'reject') {
      const [updated] = await db
        .update(tsrfRequests)
        .set({ approvalStatus: 'rejected', tripStatus: 'cancelled' })
        .where(eq(tsrfRequests.id, id))
        .returning();
      return updated;
    }

    let nextStatus: 'pending' | 'dept_approved' | 'logistics_approved' | 'finance_approved' =
      tsrf.approvalStatus as any;

    if (role === 'department_head') {
      nextStatus = 'dept_approved';
    } else if (role === 'logistics_head') {
      nextStatus = 'logistics_approved';
    } else if (role === 'finance_manager') {
      nextStatus = 'finance_approved';
    }

    const tripStatus = nextStatus === 'finance_approved' ? 'approved' : tsrf.tripStatus;

    const [updated] = await db
      .update(tsrfRequests)
      .set({
        approvalStatus: nextStatus,
        tripStatus,
      })
      .where(eq(tsrfRequests.id, id))
      .returning();

    logger.info(
      { id, role, newStatus: nextStatus },
      '[TsrfService] TSRF endorsement processed',
    );

    return updated;
  }

  static async completeTrip(
    id: string,
    input: { endingKm: number; assignedVehicleId?: string },
  ) {
    const tsrf = await this.getTsrfById(id);
    if (!tsrf) throw new Error(`TSRF with ID ${id} not found`);

    const vehicleId = input.assignedVehicleId || tsrf.assignedVehicleId;
    let updatedVehicle = null;

    if (vehicleId) {
      updatedVehicle = await VehicleService.updateMileage(vehicleId, input.endingKm);
    }

    const [updatedTsrf] = await db
      .update(tsrfRequests)
      .set({
        endingKm: input.endingKm,
        tripStatus: 'completed',
      })
      .where(eq(tsrfRequests.id, id))
      .returning();

    logger.info(
      {
        tsrfId: id,
        endingKm: input.endingKm,
        vehicleId,
        vehiclePmsStatus: updatedVehicle?.status,
      },
      '[TsrfService] TSRF trip completed & odometer updated',
    );

    return {
      tsrf: updatedTsrf,
      vehicle: updatedVehicle,
    };
  }
}
