import { z } from 'zod';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import {
  vehicles,
  purchaseRequisitions,
  pmsRecords,
  repairWorkOrders,
  incidentReports,
  tsrfRequests,
} from './schema.js';

// Vehicles
export const insertVehicleSchema = createInsertSchema(vehicles);
export const selectVehicleSchema = createSelectSchema(vehicles);

// Purchase Requisitions
export const insertPurchaseRequisitionSchema = createInsertSchema(purchaseRequisitions);
export const selectPurchaseRequisitionSchema = createSelectSchema(purchaseRequisitions);

// PMS Records
export const insertPmsRecordSchema = createInsertSchema(pmsRecords);
export const selectPmsRecordSchema = createSelectSchema(pmsRecords);

// Repair Work Orders
export const insertRepairWorkOrderSchema = createInsertSchema(repairWorkOrders);
export const selectRepairWorkOrderSchema = createSelectSchema(repairWorkOrders);

// Incident Reports
export const insertIncidentReportSchema = createInsertSchema(incidentReports);
export const selectIncidentReportSchema = createSelectSchema(incidentReports);

// TSRF Requests
export const insertTsrfRequestSchema = createInsertSchema(tsrfRequests);
export const selectTsrfRequestSchema = createSelectSchema(tsrfRequests);

// Waypoint / Stop schema for Multi-Stop routing
export const routeStopSchema = z.object({
  stopOrder: z.number().int().min(1),
  locationName: z.string().min(1),
  address: z.string().min(1),
  arrivalTime: z.string().optional(),
  departureTime: z.string().optional(),
  waitingTimeMinutes: z.number().int().nonnegative().default(0),
  notes: z.string().optional(),
});

// Passenger Manifest schema
export const passengerSchema = z.object({
  name: z.string().min(1),
  department: z.string().min(1),
  role: z.string().optional(),
  contactNumber: z.string().optional(),
});

// Cargo schema
export const cargoItemSchema = z.object({
  description: z.string().min(1),
  quantity: z.number().int().positive().default(1),
  weightKg: z.number().positive().optional(),
  isFragile: z.boolean().default(false),
});

export type InsertVehicle = z.infer<typeof insertVehicleSchema>;
export type SelectVehicle = z.infer<typeof selectVehicleSchema>;
export type InsertPurchaseRequisition = z.infer<typeof insertPurchaseRequisitionSchema>;
export type SelectPurchaseRequisition = z.infer<typeof selectPurchaseRequisitionSchema>;
export type InsertRepairWorkOrder = z.infer<typeof insertRepairWorkOrderSchema>;
export type SelectRepairWorkOrder = z.infer<typeof selectRepairWorkOrderSchema>;
export type InsertTsrfRequest = z.infer<typeof insertTsrfRequestSchema>;
export type SelectTsrfRequest = z.infer<typeof selectTsrfRequestSchema>;
