export interface SlotScope {
  clinicId: string;
  facilityId: string;
  doctorId: string;
  addressId: string;
}
export interface ManagedSlotState extends SlotScope {
  version: 1;
  hash: string;
  ranges: Array<{ start: string; end: string }>;
}

export function managedSlotState(
  scope: SlotScope,
  hash: string,
  slots: Array<{ start: string; end: string }>,
): ManagedSlotState {
  return {
    ...scope,
    version: 1,
    hash,
    ranges: slots.map(({ start, end }) => ({ start, end })),
  };
}

/** An old hash alone is not evidence of which time spans we may remove. */
export function managedClearPayload(
  state: unknown,
  expectedHash: string,
  scope: SlotScope,
  dates: string[],
) {
  const previous = state as ManagedSlotState | null;
  if (
    !previous ||
    previous.version !== 1 ||
    previous.hash !== expectedHash ||
    !scope.clinicId ||
    Object.keys(scope).some((key) => previous[key] !== scope[key]) ||
    !Array.isArray(previous.ranges) ||
    !previous.ranges.length
  )
    return null;
  const allowed = new Set(dates);
  const slots: Array<{
    start: string;
    end: string;
    address_services: never[];
  }> = [];
  for (const range of previous.ranges) {
    if (
      !range ||
      typeof range.start !== 'string' ||
      typeof range.end !== 'string' ||
      !range.start.endsWith('-03:00') ||
      !range.end.endsWith('-03:00') ||
      !Number.isFinite(Date.parse(range.start)) ||
      Date.parse(range.end) <= Date.parse(range.start) ||
      !Number.isFinite(Date.parse(range.end))
    )
      return null;
    // Never widen the prior interval or clear dates not covered by the complete source snapshot.
    if (
      !allowed.has(range.start.slice(0, 10)) ||
      !allowed.has(range.end.slice(0, 10))
    ) {
      // Expired intervals need no remote removal; future intervals outside the
      // snapshot must retain their evidence instead of marking everything empty.
      if (range.end.slice(0, 10) < [...allowed].sort()[0]) continue;
      return null;
    }
    slots.push({ start: range.start, end: range.end, address_services: [] });
  }
  return slots.length ? { slots } : null;
}
