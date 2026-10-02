/**
 * Reference: docs/FLEET_DOMAIN_RULES.md - Rule 2 & Rule 3
 * Rule 2: A repair work order cannot move to "approved" without a PMS compliance check.
 * Rule 3: If PMS was skipped, an incident/damage report is mandatory before the repair proceeds.
 */

export interface RepairApprovalInput {
  isPmsCompliant: boolean;
  wasPmsSkipped: boolean;
  incidentReportFiled: boolean;
}

export interface RepairApprovalResult {
  canApprove: boolean;
  reason?: string;
}

export function validateRepairApproval(input: RepairApprovalInput): RepairApprovalResult {
  // Rule 2: A repair work order cannot move to "approved" without a PMS compliance check.
  if (!input.isPmsCompliant) {
    return {
      canApprove: false,
      reason: 'Repair work order cannot be approved: Vehicle failed PMS compliance check.',
    };
  }

  // Rule 3: If PMS was skipped, an incident/damage report is mandatory before the repair proceeds.
  if (input.wasPmsSkipped && !input.incidentReportFiled) {
    return {
      canApprove: false,
      reason:
        'Repair work order cannot proceed: PMS was skipped and mandatory incident/damage report has not been filed.',
    };
  }

  return { canApprove: true };
}
