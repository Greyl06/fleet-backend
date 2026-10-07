import { isPmsOverdue } from "./pms.js";

export type VehicleOperationalStatus =
  | "active"
  | "pms_due"
  | "in_maintenance"
  | "decommissioned";

export interface OdometerVehicleState {
  currentKm: number;
  lastPmsKm: number;
  pmsIntervalKm: number;
  status: VehicleOperationalStatus;
}

export function calculateOdometerUpdate(
  vehicle: OdometerVehicleState,
  endingKm: number,
): Pick<OdometerVehicleState, "currentKm" | "status"> {
  if (!Number.isSafeInteger(endingKm) || endingKm < 0)
    throw new Error("Ending KM must be a non-negative whole number.");
  if (endingKm < vehicle.currentKm) {
    throw new Error(
      `Ending KM (${endingKm}) cannot be less than current odometer reading (${vehicle.currentKm})`,
    );
  }

  const isOverdue = isPmsOverdue({
    currentKm: endingKm,
    lastCompletedPmsKm: vehicle.lastPmsKm,
    intervalKm: vehicle.pmsIntervalKm,
  });
  return {
    currentKm: endingKm,
    status: isOverdue || vehicle.status === "pms_due" ? "pms_due" : vehicle.status,
  };
}