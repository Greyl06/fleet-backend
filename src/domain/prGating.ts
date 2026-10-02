/**
 * Reference: docs/FLEET_DOMAIN_RULES.md - Rule 4 (Single Centralized PR Gatekeeper)
 * Nothing unlocks (repair work order or TSRF trip) until the linked
 * Purchase Requisition status = "approved" — this check lives in exactly one
 * place, never duplicated per route.
 */

export class PurchaseRequisitionGatingError extends Error {
  constructor(message = 'Operation locked: Linked Purchase Requisition is not approved.') {
    super(message);
    this.name = 'PurchaseRequisitionGatingError';
  }
}

/**
 * Single centralized validation check for Purchase Requisition unlocking.
 * NEVER duplicate this logic per route or module.
 */
export function isPrApproved(status: string | null | undefined): boolean {
  return status?.trim().toLowerCase() === 'approved';
}

export function assertPrApproved(status: string | null | undefined): void {
  if (!isPrApproved(status)) {
    throw new PurchaseRequisitionGatingError(
      `Purchase Requisition must be in "approved" status before unlocking. Current status: "${status ?? 'none'}".`,
    );
  }
}
