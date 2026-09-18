import { Period, object, planManagedRemoval, snapshotMatches } from './managed-period-replacement';
import { SlotScope } from './managed-slot-ranges';

export interface ReplacementClient {
  getSlotsForReconciliation(f: string, d: string, a: string, start: string, end: string): Promise<unknown>;
  getBookings(f: string, d: string, a: string, start: string, end: string): Promise<unknown>;
  getCalendarBreaks(f: string, d: string, a: string, start: string, end: string): Promise<unknown>;
  replaceSlots(f: string, d: string, a: string, payload: { slots: Period[] }): Promise<unknown>;
}
function emptyComplete(value: unknown): boolean {
  const o = object(value);
  return !!o && Array.isArray(o._items) && o._items.length === 0 && !object(o._links)?.next && (o.total === undefined || o.total === 0);
}

/** Unknown remote state must never be reconstructed from slot starts or service defaults. */
export async function reconcileManagedRemoval(input: {
  state: unknown; hash: string; scope: SlotScope; targets: { start: string; end: string }[];
  client: ReplacementClient; authorized: () => Promise<boolean>; persist: (remaining: Period[]) => Promise<void>;
  now?: Date; verifyAttempts?: number;
}): Promise<boolean> {
  const plan = planManagedRemoval(input.state, input.hash, input.scope, input.targets, input.now);
  if (!plan) return false;
  const { facilityId: f, doctorId: d, addressId: a } = input.scope;
  const start = `${plan.dates[0]}T00:00:00-03:00`, end = `${plan.dates[0]}T23:59:59-03:00`;
  const read = () => input.client.getSlotsForReconciliation(f, d, a, start, end);
  try {
    if (!await input.authorized()) return false;
    // Do not touch occupied days: free-slot enumeration cannot reconstruct hidden periods.
    if (!emptyComplete(await input.client.getBookings(f, d, a, start, end)) || !emptyComplete(await input.client.getCalendarBreaks(f, d, a, start, end))) return false;
    if (!snapshotMatches(await read(), plan.before)) return false;
    if (!await input.authorized() || !snapshotMatches(await read(), plan.before)) return false;
    await input.client.replaceSlots(f, d, a, { slots: plan.slots });
    for (let attempt = 0; attempt < (input.verifyAttempts ?? 5); attempt++) {
      if (snapshotMatches(await read(), plan.after)) {
        await input.persist(plan.remaining);
        return true;
      }
      if (attempt + 1 < (input.verifyAttempts ?? 5)) await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } catch { /* Retain original journal after timeout, divergence or failed persistence. */ }
  return false;
}
