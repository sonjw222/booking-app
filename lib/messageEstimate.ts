export function estimateAlimtalkCost(recipients: number, unitPrice: number | null, approvedTemplate: boolean): number | null {
  if (!approvedTemplate || unitPrice == null || !Number.isFinite(unitPrice) || unitPrice < 0 || !Number.isInteger(recipients) || recipients < 0) return null;
  return recipients * unitPrice;
}
