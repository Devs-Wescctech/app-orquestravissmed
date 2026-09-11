import { AsyncLocalStorage } from 'node:async_hooks';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

type Outcome = 'created' | 'updated' | 'unchanged' | 'errors';
export type RecordCounts = {
  verified: number;
  created: number;
  updated: number;
  unchanged: number;
  errors: number;
};
interface Observation {
  categories: Record<string, RecordCounts>;
  seen: Map<string, Outcome>;
  stages: Array<{ name: string; durationMs: number }>;
  stage: string;
  since: number;
}
const context = new AsyncLocalStorage<Observation>();
export const emptyCounts = (): RecordCounts => ({
  verified: 0,
  created: 0,
  updated: 0,
  unchanged: 0,
  errors: 0,
});

export function recordOutcome(category: string, key: string, outcome: Outcome) {
  const state = context.getStore();
  if (!state) return;
  const counts = (state.categories[category] ??= emptyCounts());
  const id = `${category}:${key}`;
  const previous = state.seen.get(id);
  if (previous) {
    // One logical record per category, even if encountered at several addresses.
    if (
      previous === 'errors' ||
      previous === outcome ||
      (previous === 'created' && outcome !== 'errors') ||
      (previous === 'updated' && outcome === 'unchanged')
    )
      return;
    counts[previous]--;
  } else counts.verified++;
  state.seen.set(id, outcome);
  counts[outcome]++;
}

export function beginSyncStage(name: string) {
  const state = context.getStore();
  if (!state) return;
  state.stages.push({
    name: state.stage,
    durationMs: Date.now() - state.since,
  });
  state.stage = name;
  state.since = Date.now();
}

function comparable(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (
    value &&
    typeof value === 'object' &&
    'toNumber' in value &&
    typeof value.toNumber === 'function'
  )
    return String((value as { toNumber(): number }).toNumber());
  if (Array.isArray(value)) return `[${value.map(comparable).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return JSON.stringify(
      Object.keys(object)
        .sort()
        .filter((key) => object[key] !== undefined)
        .map((key) => [key, comparable(object[key])]),
    );
  }
  return JSON.stringify(value);
}

/** Compare business fields; timestamps alone must not cause another write. */
export async function differentialUpsert(
  delegate: unknown,
  category: string,
  args: {
    where: Record<string, unknown>;
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  },
): Promise<any> {
  // Prisma delegates vary by model; their shared operations are invoked here.
  const model = delegate as {
    findUnique(input: {
      where: Record<string, unknown>;
    }): Promise<Record<string, unknown> | null>;
    upsert(input: typeof args): Promise<unknown>;
  };
  const key = JSON.stringify(args.where);
  try {
    const existing = await model.findUnique({ where: args.where });
    const changed =
      !existing ||
      Object.entries(args.update).some(
        ([field, value]) =>
          value !== undefined &&
          !['syncedAt', 'updatedAt', 'lastSyncedAt'].includes(field) &&
          comparable(existing[field]) !== comparable(value),
      );
    const result = changed ? await model.upsert(args) : existing;
    if (category)
      recordOutcome(
        category,
        key,
        !existing ? 'created' : changed ? 'updated' : 'unchanged',
      );
    return result;
  } catch (error) {
    if (category) recordOutcome(category, key, 'errors');
    throw error;
  }
}

export function currentRecordTotal(): number {
  return Object.values(context.getStore()?.categories || {}).reduce(
    (sum, c) => sum + c.verified,
    0,
  );
}

export function classifySyncEvents(
  events: Array<{ entityType: string; action: string }>,
) {
  const errors = events.filter((e) =>
    /(^|_)error$|failed$/.test(e.action),
  ).length;
  const warnings = events.filter((e) =>
    /warning$|pending$|skipped_incomplete|skipped_no_approved_mapping/.test(
      e.action,
    ),
  ).length;
  const agendas = events
    .filter((e) => e.entityType === 'SLOT_SYNC')
    .reduce(
      (counts, e) => {
        if (
          [
            'created',
            'cleared',
            'unchanged',
            'skipped_empty',
            'error',
            'skipped_incomplete',
            'managed_scope_pending',
            'mapping_pending',
          ].includes(e.action)
        ) {
          counts[e.action] = (counts[e.action] || 0) + 1;
        }
        return counts;
      },
      {} as Record<string, number>,
    );
  return { errors, warnings, agendas };
}

/** Also runs on the direct fallback; preserves existing metrics and historical runs. */
export async function observeSync<T>(
  prisma: PrismaService,
  id: string,
  task: () => Promise<T>,
): Promise<T> {
  return context.run(
    {
      categories: {},
      seen: new Map(),
      stages: [],
      stage: 'initializing',
      since: Date.now(),
    },
    async () => {
      try {
        return await task();
      } finally {
        const state = context.getStore();
        beginSyncStage('finished');
        const run = await prisma.syncRun.findUnique({ where: { id } });
        if (run) {
          const events = await prisma.syncEvent.findMany({
            where: { syncRunId: id },
            select: { entityType: true, action: true },
          });
          const issues = classifySyncEvents(events);
          const totals = Object.values(state.categories).reduce((sum, c) => {
            for (const key of Object.keys(sum) as Array<keyof RecordCounts>)
              sum[key] += c[key];
            return sum;
          }, emptyCounts());
          const hasIssues = issues.errors + issues.warnings + totals.errors > 0;
          await prisma.syncRun.update({
            where: { id },
            data: {
              status:
                run.status === 'completed' && hasIssues
                  ? 'completed_with_warnings'
                  : run.status,
              totalRecords: totals.verified,
              metrics: {
                ...((run.metrics as Prisma.JsonObject) || {}),
                report: {
                  version: 2,
                  categories: state.categories,
                  totals,
                  stages: state.stages,
                  ...issues,
                },
              },
            },
          });
        }
      }
    },
  );
}
