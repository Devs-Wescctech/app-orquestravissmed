import { createHash } from 'crypto';
import { SlotScope } from './managed-slot-ranges';

export type Period = {
  start: string;
  end: string;
  address_services: { address_service_id: string | number; duration: number }[];
  insurance_accepted?: string;
  insurance_providers?: number[];
  insurance_plans?: number[];
};
export const periodsHash = (periods: Period[]) =>
  createHash('sha256').update(JSON.stringify(periods)).digest('hex');
export function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>) : null;
}
const id = (value: unknown) => (typeof value === 'number' || typeof value === 'string') && /^[1-9]\d*$/.test(String(value));
const timestamp = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00-03:00$/.test(value) && Number.isFinite(Date.parse(value));

export function validPeriods(input: unknown): input is Period[] {
  if (!Array.isArray(input)) return false;
  const rows: unknown[] = input;
  const allowed = new Set(['start', 'end', 'address_services', 'insurance_accepted', 'insurance_providers', 'insurance_plans']);
  for (const item of rows) {
    const p = object(item);
    if (!p || Object.keys(p).some(k => !allowed.has(k)) || !timestamp(p.start) || !timestamp(p.end) || p.start.slice(0, 10) !== p.end.slice(0, 10) || Date.parse(p.end) <= Date.parse(p.start) || !Array.isArray(p.address_services) || !p.address_services.length) return false;
    const services: unknown[] = p.address_services;
    const ids = new Set<string>();
    for (const value of services) {
      const s = object(value);
      if (!s || Object.keys(s).some(k => !['address_service_id', 'duration'].includes(k)) || !id(s.address_service_id) || typeof s.duration !== 'number' || !Number.isInteger(s.duration) || s.duration < 1 || s.duration > 1440 || s.duration * 60000 > Date.parse(p.end) - Date.parse(p.start)) return false;
      const key = String(s.address_service_id);
      if (ids.has(key)) return false;
      ids.add(key);
    }
    if (p.insurance_accepted !== undefined && !['with-and-without-insurance', 'without-insurance-only', 'with-insurance-only'].includes(String(p.insurance_accepted))) return false;
    for (const key of ['insurance_providers', 'insurance_plans']) {
      if (p[key] !== undefined && (!Array.isArray(p[key]) || !(p[key] as unknown[]).every(v => typeof v === 'number' && Number.isSafeInteger(v) && v > 0))) return false;
    }
  }
  const sorted = [...(input as Period[])].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return sorted.every((p, i) => !i || Date.parse(sorted[i - 1].end) <= Date.parse(p.start));
}

export function planManagedRemoval(state: unknown, hash: string, scope: SlotScope, targets: { start: string; end: string }[], now = new Date()) {
  const s = object(state);
  if (!s || s.version !== 1 || s.hash !== hash || !scope.clinicId || Object.entries(scope).some(([k, v]) => s[k] !== v) || !validPeriods(s.periods) || periodsHash(s.periods) !== hash || !Array.isArray(s.ranges) || JSON.stringify(s.ranges) !== JSON.stringify(s.periods.map(({ start, end }) => ({ start, end }))) || !targets.length || !Number.isFinite(now.getTime())) return null;
  const periods = s.periods;
  if (targets.some(t => !periods.some(p => p.start === t.start && p.end === t.end) || Date.parse(t.start) < now.getTime())) return null;
  const dates = [...new Set(targets.map(t => t.start.slice(0, 10)))];
  // One date per replacement; persist each confirmed date before proceeding to the next.
  if (dates.length !== 1) return null;
  const removed = (p: Period) => targets.some(t => t.start === p.start && t.end === p.end);
  const before = periods.filter(p => dates.includes(p.start.slice(0, 10)));
  const remaining = periods.filter(p => !removed(p));
  const slots = before.map(p => removed(p) ? { start: p.start, end: p.end, address_services: [] } : p);
  return { before, remaining, slots, dates, after: before.filter(p => !removed(p)) };
}

function expectedSlots(periods: Period[]): string[] {
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
  const result: string[] = [];
  for (const period of periods) {
    const step = period.address_services.map(s => s.duration).reduce(gcd) * 60000;
    for (let tick = Date.parse(period.start); tick < Date.parse(period.end); tick += step) {
      const services = period.address_services.filter(s => tick + s.duration * 60000 <= Date.parse(period.end)).map(s => String(s.address_service_id)).sort();
      if (services.length) result.push(`${tick}|${services.join(',')}`);
    }
  }
  return result.sort();
}

export function snapshotMatches(body: unknown, periods: Period[]): boolean {
  const b = object(body);
  if (!b || !Array.isArray(b._items) || object(b._links)?.next || !validPeriods(periods)) return false;
  if (typeof b.total === 'number' && b.total !== b._items.length) return false;
  const actual: string[] = [];
  for (const value of b._items as unknown[]) {
    const row = object(value), services = object(row?.address_services)?._items;
    if (!row || typeof row.start !== 'string' || !Number.isFinite(Date.parse(row.start)) || !Array.isArray(services) || !services.length) return false;
    const ids: string[] = [];
    for (const entry of services as unknown[]) {
      const serviceId = object(entry)?.id;
      if (!id(serviceId)) return false;
      ids.push(String(serviceId));
    }
    actual.push(`${Date.parse(row.start)}|${ids.sort().join(',')}`);
  }
  return JSON.stringify(actual.sort()) === JSON.stringify(expectedSlots(periods));
}
