import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import {
  calculateCostPerKm,
  evaluateCostRating,
  computeFleetTcoAnalysis,
  type VehicleCostData,
} from '../src/domain/tco.js';

describe('Fleet TCO & Cost-per-Kilometer (CPK) Domain Calculations', () => {
  it('safely calculates Cost-per-Kilometer without division by zero', () => {
    // Normal case
    expect(calculateCostPerKm(15000, 3000)).toBe(5);
    expect(calculateCostPerKm(7500, 2500)).toBe(3);
    // Decimal rounding
    expect(calculateCostPerKm(10000, 3000)).toBe(3.33);
    // Zero KM edge case: must not return Infinity or NaN
    expect(calculateCostPerKm(5000, 0)).toBe(5000);
    expect(calculateCostPerKm(0, 0)).toBe(0);
  });

  it('evaluates vehicle cost rating against fleet benchmark correctly', () => {
    const fleetAvg = 5.0; // ₱5.00 / km

    // <= 115% (<= 5.75) -> optimal
    expect(evaluateCostRating(4.5, fleetAvg, 2000)).toBe('optimal');
    expect(evaluateCostRating(5.5, fleetAvg, 2000)).toBe('optimal');

    // > 115% and <= 135% (5.76 to 6.75) -> elevated
    expect(evaluateCostRating(6.0, fleetAvg, 2000)).toBe('elevated');
    expect(evaluateCostRating(6.5, fleetAvg, 2000)).toBe('elevated');

    // > 135% (> 6.75) -> critical_outlier
    expect(evaluateCostRating(7.5, fleetAvg, 2000)).toBe('critical_outlier');
    expect(evaluateCostRating(12.0, fleetAvg, 2000)).toBe('critical_outlier');

    // Low distance safeguard (< 50 km)
    expect(evaluateCostRating(10.0, fleetAvg, 25)).toBe('elevated');
  });

  it('aggregates fleet dataset across types, departments, and monthly trends', () => {
    const mockVehicles: VehicleCostData[] = [
      {
        vehicleId: 'v-1',
        plateNumber: 'VAN-1001',
        model: 'Toyota HiAce Commuter',
        vehicleType: 'commuter_van',
        assignedDriver: 'Juan Dela Cruz',
        currentKm: 10000,
        lastPmsKm: 10000,
        status: 'active',
        repairSpend: 20000,
        pmsSpend: 9000,
        workOrderCount: 2,
        pmsCompletedCount: 2,
        department: 'Logistics',
      },
      {
        vehicleId: 'v-2',
        plateNumber: 'TRK-2002',
        model: 'Isuzu Elf 4W',
        vehicleType: 'truck_4w',
        assignedDriver: 'Pedro Santos',
        currentKm: 5000,
        lastPmsKm: 5000,
        status: 'active',
        repairSpend: 45000,
        pmsSpend: 4500,
        workOrderCount: 4,
        pmsCompletedCount: 1,
        department: 'Operations',
      },
      {
        vehicleId: 'v-3',
        plateNumber: 'VAN-1003',
        model: 'Nissan Urvan NV350',
        vehicleType: 'commuter_van',
        assignedDriver: null,
        currentKm: 15000,
        lastPmsKm: 15000,
        status: 'active',
        repairSpend: 15000,
        pmsSpend: 13500,
        workOrderCount: 1,
        pmsCompletedCount: 3,
        department: 'Logistics',
      },
    ];

    const summary = computeFleetTcoAnalysis(mockVehicles);

    // Total KM = 10000 + 5000 + 15000 = 30000
    expect(summary.totalFleetKm).toBe(30000);
    // Total spend = (20000+9000) + (45000+4500) + (15000+13500) = 29000 + 49500 + 28500 = 107000
    expect(summary.totalFleetSpend).toBe(107000);
    // Fleet Average CPK = 107000 / 30000 = 3.57
    expect(summary.fleetAverageCpk).toBe(3.57);

    // Highest CPK vehicle is TRK-2002 (49500 / 5000 = 9.90)
    expect(summary.highestCpkVehicle?.plateNumber).toBe('TRK-2002');
    expect(summary.highestCpkVehicle?.costPerKm).toBe(9.9);

    // Outlier watchlist contains TRK-2002 as critical outlier (9.90 is > 1.35 * 3.57)
    expect(summary.outlierWatchlist.length).toBeGreaterThan(0);
    expect(summary.outlierWatchlist[0].plateNumber).toBe('TRK-2002');
    expect(summary.outlierWatchlist[0].costRating).toBe('critical_outlier');

    // Vehicle types: commuter_van and truck_4w
    expect(summary.byVehicleType.length).toBe(2);
    const vanType = summary.byVehicleType.find((t) => t.vehicleType === 'commuter_van');
    expect(vanType?.vehicleCount).toBe(2);
    expect(vanType?.totalKm).toBe(25000);

    // Departments: Logistics and Operations
    expect(summary.byDepartment.length).toBe(2);

    // Monthly trend contains last 6 months
    expect(summary.monthlyTrend.length).toBe(6);
  });
});

describe('Fleet Analytics REST API Integration', () => {
  it('GET /api/analytics/tco returns 200 with full TCO data for authorized roles', async () => {
    const res = await request(app)
      .get('/api/analytics/tco')
      .set('x-user-id', 'test-admin-id')
      .set('x-user-role', 'admin')
      .set('x-user-name', 'Admin Tester');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('fleetAverageCpk');
    expect(res.body).toHaveProperty('totalFleetSpend');
    expect(res.body).toHaveProperty('totalFleetKm');
    expect(res.body).toHaveProperty('metrics');
    expect(res.body).toHaveProperty('byVehicleType');
    expect(res.body).toHaveProperty('byDepartment');
    expect(res.body).toHaveProperty('monthlyTrend');
    expect(Array.isArray(res.body.metrics)).toBe(true);
    expect(Array.isArray(res.body.byVehicleType)).toBe(true);
  });

  it('GET /api/analytics/vehicles/:id returns 404 for unknown vehicle ID', async () => {
    const res = await request(app)
      .get('/api/analytics/vehicles/00000000-0000-0000-0000-000000000000')
      .set('x-user-id', 'test-admin-id')
      .set('x-user-role', 'admin');

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error', 'Vehicle not found');
  });
});
