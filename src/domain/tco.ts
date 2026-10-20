/**
 * Fleet Total Cost of Ownership (TCO) & Cost-per-Kilometer (CPK) Domain Calculations
 * Enforces standardized financial formulas and outlier detection across the fleet.
 */

export interface VehicleCostData {
  vehicleId: string;
  plateNumber: string;
  model: string;
  vehicleType: string;
  assignedDriver: string | null;
  currentKm: number;
  lastPmsKm: number;
  status: string;
  repairSpend: number;
  pmsSpend: number;
  workOrderCount: number;
  pmsCompletedCount: number;
  department?: string | null;
}

export interface VehicleTcoMetric extends VehicleCostData {
  totalMaintenanceSpend: number;
  costPerKm: number; // in PHP / KM
  costRating: 'optimal' | 'elevated' | 'critical_outlier';
  benchmarkComparisonPct: number; // percentage above/below fleet average
}

export interface TypeAggregation {
  vehicleType: string;
  vehicleCount: number;
  totalKm: number;
  totalSpend: number;
  averageCostPerKm: number;
}

export interface DepartmentAggregation {
  department: string;
  vehicleCount: number;
  totalSpend: number;
  totalKm: number;
  averageCostPerKm: number;
}

export interface MonthlySpendTrend {
  monthKey: string; // e.g. "2026-05"
  monthLabel: string; // e.g. "May 2026"
  repairSpend: number;
  pmsSpend: number;
  totalSpend: number;
  workOrderCount: number;
}

export interface FleetTcoSummary {
  fleetAverageCpk: number; // PHP / KM
  totalFleetSpend: number; // PHP
  totalFleetKm: number;
  totalVehicles: number;
  activeVehicles: number;
  criticalOutliersCount: number;
  highestCpkVehicle: {
    plateNumber: string;
    model: string;
    costPerKm: number;
    totalSpend: number;
  } | null;
  metrics: VehicleTcoMetric[];
  byVehicleType: TypeAggregation[];
  byDepartment: DepartmentAggregation[];
  monthlyTrend: MonthlySpendTrend[];
  outlierWatchlist: VehicleTcoMetric[];
}

/**
 * Calculates Cost-per-Kilometer safely without division-by-zero errors.
 * Minimum divisor is 1 KM.
 */
export function calculateCostPerKm(totalSpend: number, currentKm: number): number {
  const safeKm = Math.max(1, currentKm);
  const cpk = totalSpend / safeKm;
  // Round to two decimal places
  return Math.round(cpk * 100) / 100;
}

/**
 * Evaluates whether a vehicle is an outlier relative to the fleet average CPK.
 * - Optimal: <= 115% of fleet average
 * - Elevated: 115% to 135% of fleet average
 * - Critical Outlier: > 135% of fleet average ("Fleet Money Pit")
 */
export function evaluateCostRating(
  vehicleCpk: number,
  fleetAverageCpk: number,
  currentKm: number,
): 'optimal' | 'elevated' | 'critical_outlier' {
  // If vehicle has barely driven (< 50 km), do not flag as critical outlier due to low sample size
  if (currentKm < 50 && vehicleCpk > fleetAverageCpk) {
    return 'elevated';
  }

  if (fleetAverageCpk <= 0) {
    return vehicleCpk > 20 ? 'elevated' : 'optimal';
  }

  const ratio = vehicleCpk / fleetAverageCpk;
  if (ratio > 1.35) {
    return 'critical_outlier';
  }
  if (ratio > 1.15) {
    return 'elevated';
  }
  return 'optimal';
}

/**
 * Aggregates all vehicle metrics into a complete Fleet TCO analysis package.
 */
export function computeFleetTcoAnalysis(
  vehicleDataList: VehicleCostData[],
  monthlyEvents: { date: Date; amount: number; isPms: boolean }[] = [],
): FleetTcoSummary {
  const totalVehicles = vehicleDataList.length;
  const activeVehicles = vehicleDataList.filter((v) => v.status === 'active').length;

  let totalFleetSpend = 0;
  let totalFleetKm = 0;

  for (const v of vehicleDataList) {
    totalFleetSpend += (v.repairSpend || 0) + (v.pmsSpend || 0);
    totalFleetKm += v.currentKm || 0;
  }

  const fleetAverageCpk = calculateCostPerKm(totalFleetSpend, totalFleetKm);

  // Compute individual vehicle metrics
  const metrics: VehicleTcoMetric[] = vehicleDataList.map((v) => {
    const totalSpend = (v.repairSpend || 0) + (v.pmsSpend || 0);
    const costPerKm = calculateCostPerKm(totalSpend, v.currentKm);
    const costRating = evaluateCostRating(costPerKm, fleetAverageCpk, v.currentKm);
    const benchmarkComparisonPct =
      fleetAverageCpk > 0
        ? Math.round(((costPerKm - fleetAverageCpk) / fleetAverageCpk) * 100)
        : 0;

    return {
      ...v,
      totalMaintenanceSpend: totalSpend,
      costPerKm,
      costRating,
      benchmarkComparisonPct,
    };
  });

  // Sort metrics by costPerKm descending
  metrics.sort((a, b) => b.costPerKm - a.costPerKm);

  // Critical outliers
  const outlierWatchlist = metrics
    .filter((m) => m.costRating === 'critical_outlier' || (m.costRating === 'elevated' && m.totalMaintenanceSpend > 50000))
    .slice(0, 5);

  const highestCpkVehicle =
    metrics.length > 0 && metrics[0].totalMaintenanceSpend > 0
      ? {
          plateNumber: metrics[0].plateNumber,
          model: metrics[0].model,
          costPerKm: metrics[0].costPerKm,
          totalSpend: metrics[0].totalMaintenanceSpend,
        }
      : null;

  // Breakdown by Vehicle Type
  const typeMap = new Map<string, { count: number; km: number; spend: number }>();
  for (const m of metrics) {
    const t = m.vehicleType || 'commuter_van';
    const curr = typeMap.get(t) || { count: 0, km: 0, spend: 0 };
    curr.count += 1;
    curr.km += m.currentKm;
    curr.spend += m.totalMaintenanceSpend;
    typeMap.set(t, curr);
  }

  const byVehicleType: TypeAggregation[] = Array.from(typeMap.entries()).map(
    ([vehicleType, data]) => ({
      vehicleType,
      vehicleCount: data.count,
      totalKm: data.km,
      totalSpend: data.spend,
      averageCostPerKm: calculateCostPerKm(data.spend, data.km),
    }),
  );

  // Breakdown by Department
  const deptMap = new Map<string, { count: number; spend: number; km: number }>();
  for (const m of metrics) {
    const dept = m.department || 'Fleet Operations';
    const curr = deptMap.get(dept) || { count: 0, spend: 0, km: 0 };
    curr.count += 1;
    curr.spend += m.totalMaintenanceSpend;
    curr.km += m.currentKm;
    deptMap.set(dept, curr);
  }

  const byDepartment: DepartmentAggregation[] = Array.from(deptMap.entries()).map(
    ([department, data]) => ({
      department,
      vehicleCount: data.count,
      totalSpend: data.spend,
      totalKm: data.km,
      averageCostPerKm: calculateCostPerKm(data.spend, data.km),
    }),
  );

  // Monthly trend for the past 6 months
  const monthlyMap = new Map<string, { repair: number; pms: number; count: number; date: Date }>();

  // Ensure last 6 months exist in the map
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    monthlyMap.set(key, { repair: 0, pms: 0, count: 0, date: d });
  }

  for (const evt of monthlyEvents) {
    const key = `${evt.date.getFullYear()}-${String(evt.date.getMonth() + 1).padStart(2, '0')}`;
    const entry = monthlyMap.get(key);
    if (entry) {
      if (evt.isPms) {
        entry.pms += evt.amount;
      } else {
        entry.repair += evt.amount;
      }
      entry.count += 1;
    }
  }

  const monthFormatter = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' });
  const monthlyTrend: MonthlySpendTrend[] = Array.from(monthlyMap.entries()).map(
    ([monthKey, data]) => {
      const total = data.repair + data.pms;
      return {
        monthKey,
        monthLabel: monthFormatter.format(data.date),
        repairSpend: data.repair,
        pmsSpend: data.pms,
        totalSpend: total,
        workOrderCount: data.count,
      };
    },
  );

  return {
    fleetAverageCpk,
    totalFleetSpend,
    totalFleetKm,
    totalVehicles,
    activeVehicles,
    criticalOutliersCount: metrics.filter((m) => m.costRating === 'critical_outlier').length,
    highestCpkVehicle,
    metrics,
    byVehicleType,
    byDepartment,
    monthlyTrend,
    outlierWatchlist,
  };
}
