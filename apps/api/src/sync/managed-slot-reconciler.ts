import {
  Period,
  object,
  planManagedRemoval,
  snapshotMatches,
} from './managed-period-replacement';
import { SlotScope } from './managed-slot-ranges';
import { CleanupDiagnostic, CleanupReason } from './cleanup-diagnostics';

export interface ReplacementClient {
  getSlotsForReconciliation(
    f: string,
    d: string,
    a: string,
    start: string,
    end: string,
  ): Promise<unknown>;
  getBookings(
    f: string,
    d: string,
    a: string,
    start: string,
    end: string,
  ): Promise<unknown>;
  getCalendarBreaks(
    f: string,
    d: string,
    a: string,
    start: string,
    end: string,
  ): Promise<unknown>;
  replaceSlots(
    f: string,
    d: string,
    a: string,
    payload: { slots: Period[] },
  ): Promise<unknown>;
}
function emptyComplete(value: unknown): boolean {
  const o = object(value);
  return (
    !!o &&
    Array.isArray(o._items) &&
    o._items.length === 0 &&
    !object(o._links)?.next &&
    (o.total === undefined || o.total === 0)
  );
}

/** Unknown remote state must never be reconstructed from slot starts or service defaults. */
export async function reconcileManagedRemoval(input: {
  state: unknown;
  hash: string;
  scope: SlotScope;
  targets: { start: string; end: string }[];
  client: ReplacementClient;
  authorized: () => Promise<boolean | CleanupReason>;
  persist: (remaining: Period[]) => Promise<void>;
  now?: Date;
  verifyAttempts?: number;
  onPending?: (diagnostic: CleanupDiagnostic) => void;
}): Promise<boolean> {
  let writeState: CleanupDiagnostic['writeState'] = 'not_sent';
  let failure: CleanupReason = 'authorization_failed';
  const pending = (code: CleanupReason) => {
    input.onPending?.({ code, writeState });
    return false;
  };
  const plan = planManagedRemoval(
    input.state,
    input.hash,
    input.scope,
    input.targets,
    input.now,
  );
  if (!plan) return pending('plan_invalid');
  const { facilityId: f, doctorId: d, addressId: a } = input.scope;
  const start = `${plan.dates[0]}T00:00:00-03:00`,
    end = `${plan.dates[0]}T23:59:59-03:00`;
  const read = () =>
    input.client.getSlotsForReconciliation(f, d, a, start, end);
  try {
    let permission = await input.authorized();
    if (permission !== true) return pending(typeof permission === 'string' ? permission : 'authorization_failed');
    failure = 'remote_read_failed';
    // Do not touch occupied days: free-slot enumeration cannot reconstruct hidden periods.
    const bookings = await input.client.getBookings(f, d, a, start, end);
    if (!emptyComplete(bookings)) return pending(Array.isArray(object(bookings)?._items) && (object(bookings)!._items as unknown[]).length ? 'bookings_present' : 'bookings_incomplete');
    const breaks = await input.client.getCalendarBreaks(f, d, a, start, end);
    if (!emptyComplete(breaks)) return pending(Array.isArray(object(breaks)?._items) && (object(breaks)!._items as unknown[]).length ? 'breaks_present' : 'breaks_incomplete');
    if (!snapshotMatches(await read(), plan.before)) return pending('remote_mismatch');
    failure = 'authorization_failed';
    permission = await input.authorized();
    if (permission !== true) return pending(typeof permission === 'string' ? permission : 'authorization_failed');
    failure = 'remote_read_failed';
    if (!snapshotMatches(await read(), plan.before)) return pending('remote_changed');
    writeState = 'unknown';
    failure = 'write_unconfirmed';
    await input.client.replaceSlots(f, d, a, { slots: plan.slots });
    failure = 'verification_failed';
    for (let attempt = 0; attempt < (input.verifyAttempts ?? 5); attempt++) {
      if (snapshotMatches(await read(), plan.after)) {
        writeState = 'confirmed';
        failure = 'journal_update_failed';
        await input.persist(plan.remaining);
        return true;
      }
      if (attempt + 1 < (input.verifyAttempts ?? 5))
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return pending('verification_mismatch');
  } catch {
    /* Retain original journal after timeout, divergence or failed persistence. */
    return pending(failure);
  }
}
