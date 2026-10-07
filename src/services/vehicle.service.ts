import { eq } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { vehicles } from '../db/schema.js';
import { getPmsStatus, isPmsOverdue } from '../domain/pms.js';
import { calculateOdometerUpdate } from '../domain/odometer.js';
import { logger } from '../config/logger.js';

export class VehicleService {
  static async listVehicles() {
    const list = await db.select().from(vehicles);
    return list.map((v) => {
      const pmsStatus = getPmsStatus(v.currentKm, v.lastPmsKm, v.pmsIntervalKm);
      return {
        ...v,
        computedPmsStatus: pmsStatus,
        nextPmsDueKm: v.lastPmsKm + v.pmsIntervalKm,
        kmUntilPmsDue: Math.max(0, v.lastPmsKm + v.pmsIntervalKm - v.currentKm),
      };
    });
  }

  static async getVehicleById(id: string) {
    const [v] = await db.select().from(vehicles).where(eq(vehicles.id, id));
    if (!v) return null;
    const pmsStatus = getPmsStatus(v.currentKm, v.lastPmsKm, v.pmsIntervalKm);
    return {
      ...v,
      computedPmsStatus: pmsStatus,
      nextPmsDueKm: v.lastPmsKm + v.pmsIntervalKm,
      kmUntilPmsDue: Math.max(0, v.lastPmsKm + v.pmsIntervalKm - v.currentKm),
    };
  }

  static async createVehicle(data: {
    plateNumber: string;
    model?: string;
    vehicleType?: 'commuter_van' | 'truck_4w' | 'truck_6w' | 'truck_10w' | 'container_unit' | '3pl_provider';
    assignedDriver?: string;
    currentKm?: number;
    lastPmsKm?: number;
    pmsIntervalKm?: number;
  }) {
    const [newVehicle] = await db
      .insert(vehicles)
      .values({
        plateNumber: data.plateNumber.toUpperCase().trim(),
        model: data.model || 'Standard Fleet Unit',
        vehicleType: data.vehicleType || 'commuter_van',
        assignedDriver: data.assignedDriver || null,
        currentKm: data.currentKm ?? 0,
        lastPmsKm: data.lastPmsKm ?? 0,
        pmsIntervalKm: data.pmsIntervalKm ?? 5000,
        status: isPmsOverdue({
          currentKm: data.currentKm ?? 0,
          lastCompletedPmsKm: data.lastPmsKm ?? 0,
          intervalKm: data.pmsIntervalKm ?? 5000,
        })
          ? 'pms_due'
          : 'active',
      })
      .returning();

    logger.info({ vehicleId: newVehicle.id, plateNumber: newVehicle.plateNumber }, '[VehicleService] Vehicle registered');
    return newVehicle;
  }

  static async updateMileage(vehicleId: string, endingKm: number) {
    const vehicle = await this.getVehicleById(vehicleId);
    if (!vehicle) {
      throw new Error(`Vehicle with ID ${vehicleId} not found`);
    }

    const odometerUpdate = calculateOdometerUpdate(vehicle, endingKm);

    const [updated] = await db
      .update(vehicles)
      .set({
        ...odometerUpdate,
        updatedAt: new Date(),
      })
      .where(eq(vehicles.id, vehicleId))
      .returning();

    logger.info(
      {
        vehicleId,
        oldKm: vehicle.currentKm,
        newKm: endingKm,
        status: odometerUpdate.status,
      },
      '[VehicleService] Vehicle odometer updated',
    );

    return updated;
  }
}
