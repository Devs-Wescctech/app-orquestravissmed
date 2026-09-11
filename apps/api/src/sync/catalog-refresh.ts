import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { DocplannerClient } from '../integrations/docplanner.service';
import { beginSyncStage, differentialUpsert } from './sync-observation';

export const CATALOG_REFRESH_MS = 12 * 60 * 60 * 1000;
type Scope = {
  id: string;
  clinicId: string;
  domain?: string | null;
  clientId?: string | null;
  catalogScopeVersion?: number;
};
export function catalogScopeKey(connection: Scope): string {
  // Only public identity, never credentials or tokens.
  return createHash('sha256')
    .update(
      JSON.stringify([
        connection.id,
        connection.clinicId,
        connection.domain,
        connection.clientId,
        connection.catalogScopeVersion,
      ]),
    )
    .digest('hex');
}

/** Durable successful checkpoint in SyncEvent; failures never advance freshness. */
export async function refreshCatalogs(
  prisma: PrismaService,
  client: DocplannerClient,
  connection: Scope,
  syncRunId: string,
) {
  const scope = catalogScopeKey(connection);
  // A deferred manual run can resume under a new ID. Keep its request pending
  // for this clinic until each catalog has a newer successful checkpoint.
  const request = await prisma.syncEvent.findFirst({
    where: {
      action: 'catalog_refresh_requested',
      syncRun: { clinicId: connection.clinicId },
    },
    orderBy: { timestamp: 'desc' },
    select: { timestamp: true },
  });
  for (const kind of ['services', 'insurances'] as const) {
    beginSyncStage(`catalog_${kind}`);
    const action = `catalog_${kind}_refreshed`;
    const checkpoint = await prisma.syncEvent.findFirst({
      where: {
        action,
        externalId: scope,
        timestamp: { gte: new Date(Date.now() - CATALOG_REFRESH_MS) },
        syncRun: { clinicId: connection.clinicId },
      },
      orderBy: { timestamp: 'desc' },
      select: { timestamp: true },
    });
    const manual =
      request && (!checkpoint || request.timestamp > checkpoint.timestamp);
    if (checkpoint && !manual) {
      await prisma.syncEvent.create({
        data: {
          syncRunId,
          entityType: 'CATALOG',
          action: 'catalog_fresh',
          externalId: scope,
          message: `${kind}: catálogo já atualizado nas últimas 12 horas; leitura e gravação dispensadas.`,
        },
      });
      continue;
    }
    try {
      // Bypass memory cache when the durable refresh is due or explicitly requested.
      const response = (await (kind === 'services'
        ? client.getServicesDictionary()
        : client.getInsuranceProviders())) as {
        _items?: unknown;
        _links?: { next?: unknown };
        pages?: unknown;
        total?: unknown;
      };
      if (
        !Array.isArray(response?._items) ||
        response._items.length === 0 ||
        response._links?.next ||
        Number(response.pages || 1) > 1 ||
        Number(response.total || 0) > response._items.length
      ) {
        throw new Error(
          'Catálogo vazio, incompleto ou paginado: atualização não confirmada.',
        );
      }
      const items = new Map<string, { id: string; name: string }>();
      for (const raw of response._items as unknown[]) {
        if (!raw || typeof raw !== 'object')
          throw new Error('Item inválido no catálogo.');
        const item = raw as Record<string, unknown>;
        const id =
          kind === 'services'
            ? item.id
            : (item.insurance_provider_id ?? item.id);
        const name =
          kind === 'services'
            ? item.name
            : (item.name ?? item.insurance_provider_name);
        if (
          (typeof id !== 'string' && typeof id !== 'number') ||
          !/^\d+$/.test(String(id)) ||
          typeof name !== 'string' ||
          !name.trim()
        ) {
          throw new Error(
            'Item inválido no catálogo; atualização não confirmada.',
          );
        }
        if (items.has(String(id)) && items.get(String(id)).name !== name)
          throw new Error('IDs conflitantes no catálogo.');
        items.set(String(id), { id: String(id), name });
      }
      const model =
        kind === 'services'
          ? prisma.doctoraliaService
          : prisma.doctoraliaInsuranceProvider;
      for (const item of items.values()) {
        const identity =
          kind === 'services'
            ? { doctoraliaServiceId: item.id }
            : { doctoraliaId: Number(item.id) };
        const data = {
          name: item.name,
          normalizedName: item.name
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .trim(),
        };
        await differentialUpsert(model, `catalog_${kind}`, {
          where: identity,
          create: { ...identity, ...data },
          update: data,
        });
      }
      await prisma.syncEvent.create({
        data: {
          syncRunId,
          entityType: 'CATALOG',
          action,
          externalId: scope,
          message: `${items.size} itens verificados em ${kind}; próxima atualização em 12 horas.`,
        },
      });
    } catch (error) {
      await prisma.syncEvent.create({
        data: {
          syncRunId,
          entityType: 'CATALOG',
          action: 'catalog_error',
          message: `${kind}: ${(error as Error).message}`,
        },
      });
    }
  }
}
