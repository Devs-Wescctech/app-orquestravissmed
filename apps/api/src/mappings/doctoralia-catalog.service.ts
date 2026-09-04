import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DocplannerClient, DocplannerService } from '../integrations/docplanner.service';
import { buildDoctoraliaDoctorUpsertData, parseLicenseStringConservative } from './license.util';
import { randomUUID } from 'crypto';

export const DOCTORALIA_CATALOG_TTL_MS = 30 * 60 * 1000;
export const DOCTORALIA_CATALOG_EXPIRED_RETENTION_MS = 24 * 60 * 60 * 1000;
const CATALOG_DEADLINE_MS = 8 * 60 * 1000;

@Injectable()
export class DoctoraliaCatalogService {
    private readonly logger = new Logger(DoctoraliaCatalogService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly docplanner?: DocplannerService,
    ) {}

    private allowlist(): Set<string> {
        return new Set((process.env.DOCTORALIA_TENANT_SAFE_DOCTOR_MATCH_CLINIC_IDS ?? '')
            .split(',').map(v => v.trim()).filter(Boolean));
    }

    /**
     * Fetches every page before opening the publishing transaction. A partial,
     * cached or failed enumeration therefore can never renew/create a generation.
     */
    async refresh(
        clinicId: string,
        connection: { id: string; catalogScopeVersion: number },
        client: DocplannerClient,
        controls?: { budget: number; owner: string; deadline: Date },
    ): Promise<{ generationId: string; facilityCount: number; doctorCount: number; getRequests: number }> {
        const assertContinue = controls
            ? () => this.assertLease(connection.id, controls.owner, controls.deadline)
            : undefined;
        const fetched = await client.enumerateFacilitiesAndDoctors(
            Math.min(40, Math.max(1, controls?.budget ?? 40)),
            assertContinue,
        );
        const records: Array<{ facilityId: string; doctor: any }> = [];
        const seen = new Set<string>();
        for (const [facilityId, doctors] of fetched.doctorsByFacility) {
            for (const doctor of doctors) {
                const externalId = String(doctor?.id ?? '').trim();
                if (!externalId) throw new Error(`Doctoralia catalog doctor without id in facility ${facilityId}`);
                const key = `${facilityId}\u0000${externalId}`;
                if (seen.has(key)) continue;
                seen.add(key);
                records.push({ facilityId, doctor });
            }
        }

        const publishedAt = new Date();
        const expiresAt = new Date(publishedAt.getTime() + DOCTORALIA_CATALOG_TTL_MS);
        const generation = await this.prisma.$transaction(async tx => {
            if (controls) {
                const locked = await tx.$queryRawUnsafe<Array<{ owner: string }>>(
                    `SELECT "owner" FROM "DoctoraliaCatalogLease"
                     WHERE "connectionId"=$1 AND "owner"=$2 AND "expiresAt">NOW()
                     FOR UPDATE`,
                    connection.id, controls.owner,
                );
                if (locked.length !== 1 || controls.deadline <= new Date()) {
                    throw new Error('Doctoralia catalog lease lost before publication');
                }
            }
            // Reauthorize/update races fail closed: the fetched scope must still be current,
            // and the clinic must still have exactly this one Doctoralia connection.
            const current = await tx.integrationConnection.findMany({
                where: { clinicId, provider: 'doctoralia' },
                select: { id: true, catalogScopeVersion: true, status: true },
            });
            if (
                current.length !== 1
                || current[0].id !== connection.id
                || current[0].catalogScopeVersion !== connection.catalogScopeVersion
                || current[0].status !== 'connected'
            ) {
                throw new Error('Doctoralia catalog scope changed or connection is ambiguous during publish');
            }

            const members: Array<{
                facilityId: string;
                doctoraliaDoctorId: string;
                doctoraliaExternalId: string;
                credentials: Array<{ council: string; number: string; uf: string | null; regional: string | null }>;
            }> = [];
            for (const record of records) {
                const upsert = buildDoctoraliaDoctorUpsertData(record.doctor, record.facilityId);
                // Catalog matching needs only normalized, immutable credential evidence.
                // Never let the raw API registration strings reach either table.
                const { licenseNumbers, ...create } = upsert.create;
                const { licenseNumbers: _ignored, ...update } = upsert.update;
                const persisted = await tx.doctoraliaDoctor.upsert({
                    where: { doctoraliaDoctorId: create.doctoraliaDoctorId },
                    create,
                    update,
                });
                const credentials = new Map<string, { council: string; number: string; uf: string | null; regional: string | null }>();
                for (const raw of licenseNumbers) {
                    const parsed = parseLicenseStringConservative(raw);
                    if (parsed.status !== 'PARSED' || !parsed.credential) continue;
                    const c = parsed.credential;
                    const value = { council: c.council, number: c.number, uf: c.uf, regional: c.regional };
                    credentials.set(`${c.council}\u0000${c.number}\u0000${c.uf ?? ''}\u0000${c.regional ?? ''}`, value);
                }
                members.push({
                    facilityId: record.facilityId,
                    doctoraliaDoctorId: persisted.id,
                    doctoraliaExternalId: persisted.doctoraliaDoctorId,
                    credentials: [...credentials.values()],
                });
            }
            if (controls) {
                const valid = await tx.$queryRawUnsafe<Array<{ owner: string }>>(
                    `SELECT "owner" FROM "DoctoraliaCatalogLease"
                     WHERE "connectionId"=$1 AND "owner"=$2 AND "expiresAt">NOW()`,
                    connection.id, controls.owner,
                );
                if (valid.length !== 1 || controls.deadline <= new Date()) {
                    throw new Error('Doctoralia catalog lease expired before generation create');
                }
            }
            // Recheck operational admission immediately before the write. A
            // read-to-publish status transition must never publish a snapshot.
            const publishConnection = await tx.integrationConnection.findUnique({
                where: { id: connection.id },
                select: { clinicId: true, provider: true, status: true, catalogScopeVersion: true },
            });
            if (
                !publishConnection
                || publishConnection.clinicId !== clinicId
                || publishConnection.provider !== 'doctoralia'
                || publishConnection.status !== 'connected'
                || publishConnection.catalogScopeVersion !== connection.catalogScopeVersion
            ) {
                throw new Error('Doctoralia connection is not connected during generation create');
            }
            const created = await tx.doctoraliaCatalogGeneration.create({
                data: {
                    clinicId,
                    connectionId: connection.id,
                    catalogScopeVersion: connection.catalogScopeVersion,
                    facilityCount: fetched.facilities.length,
                    doctorCount: members.length,
                    publishedAt,
                    expiresAt,
                    members: {
                        create: members.map(member => ({
                            ...member,
                            credentials: { create: member.credentials },
                        })),
                    },
                },
                select: { id: true },
            });
            // Bounded audit retention: keep every current generation and expired
            // generations until 24h after expiresAt. Cascades remove member and
            // credential snapshots. This runs only after successful creation and
            // in the same transaction, so a failed publish never prunes history.
            await tx.doctoraliaCatalogGeneration.deleteMany({
                where: {
                    expiresAt: {
                        lt: new Date(publishedAt.getTime() - DOCTORALIA_CATALOG_EXPIRED_RETENTION_MS),
                    },
                },
            });
            return created;
        }, { isolationLevel: 'Serializable' });

        this.logger.log(
            `[DOCTORALIA-CATALOG] published generation=${generation.id} clinicId=${clinicId} ` +
            `facilities=${fetched.facilities.length} members=${records.length} GETs=${fetched.getRequests}`,
        );
        return {
            generationId: generation.id,
            facilityCount: fetched.facilities.length,
            doctorCount: records.length,
            getRequests: fetched.getRequests,
        };
    }

    /** Explicit catalog-only entry point. It is intentionally not used by global
     * sync/manual operational paths (which can push appointments/slots). */
    async refreshClinicCatalog(clinicId: string, budget = 40): Promise<{ skipped?: string; generationId?: string }> {
        // This is deliberately the first branch: empty/not-listed means no DB
        // credential lookup, client construction, authentication, or GET.
        if (!this.allowlist().has(clinicId)) return { skipped: 'clinic_not_allowlisted' };
        if (!this.docplanner) throw new Error('Doctoralia catalog client factory is unavailable');
        const connections = await this.prisma.integrationConnection.findMany({
            where: { clinicId, provider: 'doctoralia' },
            select: { id: true, clientId: true, clientSecret: true, domain: true, status: true, catalogScopeVersion: true },
        });
        if (connections.length !== 1) {
            return { skipped: 'exactly_one_doctoralia_connection_required' };
        }
        const connection = connections[0];
        // Catalog network work follows the same operational admission rule as
        // active Doctoralia work: only an explicitly connected, configured
        // connection may authenticate or enumerate.
        if (connection.status !== 'connected') return { skipped: 'connection_not_connected' };
        if (!connection.clientId) return { skipped: 'connection_not_configured' };
        const owner = randomUUID();
        const deadline = new Date(Date.now() + CATALOG_DEADLINE_MS);
        const acquired = await this.acquireLease(connection.id, clinicId, owner);
        if (!acquired) return { skipped: 'catalog_lease_held' };
        try {
            const client = this.docplanner.createClient(
                connection.domain || 'www.doctoralia.com.br',
                connection.clientId,
                connection.clientSecret || '',
            );
            client.setCatalogAttemptGuard(() => this.consumeAttempt(connection.id, owner, deadline));
            const result = await this.refresh(clinicId, connection, client, { budget, owner, deadline });
            return { generationId: result.generationId };
        } finally {
            await this.prisma.doctoraliaCatalogLease.deleteMany({
                where: { connectionId: connection.id, owner },
            }).catch(error => {
                // Owner-conditional cleanup cannot delete a successor's lease;
                // expiry remains the safety backstop, but failure is observable.
                this.logger.warn(`[DOCTORALIA-CATALOG] owner lease cleanup failed connectionId=${connection.id}: ${error?.message}`);
            });
        }
    }

    /** Called by the existing 15-minute token-refresher cron; never owns a cron/timer. */
    async refreshAllowlistedCycle(): Promise<void> {
        const ids = [...this.allowlist()].sort();
        if (ids.length === 0) return;
        const active = await this.prisma.clinic.findMany({
            where: { active: true, id: { in: ids } },
            select: { id: true },
            orderBy: { id: 'asc' },
        });
        if (!active.length) return;
        // Fail before any external I/O if bounded housekeeping cannot complete.
        await this.prisma.$executeRawUnsafe(
            `DELETE FROM "DoctoraliaCatalogAttemptBucket"
             WHERE "bucketStart" < NOW() - INTERVAL '48 hours'`,
        );
        const bucket = Math.floor(Date.now() / (15 * 60 * 1000));
        const start = (bucket * 20) % active.length;
        const selected = Array.from({ length: Math.min(20, active.length) },
            (_, i) => active[(start + i) % active.length]);
        const logicalBudget = Math.floor(40 / selected.length);
        await Promise.allSettled(selected.map(c => this.refreshClinicCatalog(c.id, logicalBudget)));
    }

    private async acquireLease(connectionId: string, clinicId: string, owner: string): Promise<boolean> {
        const rows = await this.prisma.$queryRawUnsafe<Array<{ owner: string }>>(
            `INSERT INTO "DoctoraliaCatalogLease" ("connectionId","clinicId","owner","expiresAt","updatedAt")
             VALUES ($1,$2,$3,NOW()+INTERVAL '10 minutes',NOW())
             ON CONFLICT ("connectionId") DO UPDATE SET
               "clinicId"=EXCLUDED."clinicId","owner"=EXCLUDED."owner",
               "expiresAt"=EXCLUDED."expiresAt","updatedAt"=NOW()
             WHERE "DoctoraliaCatalogLease"."expiresAt" < NOW()
             RETURNING "owner"`,
            connectionId, clinicId, owner,
        );
        return rows.length === 1 && rows[0].owner === owner;
    }

    private async assertLease(connectionId: string, owner: string, deadline: Date): Promise<void> {
        if (deadline <= new Date()) throw new Error('Doctoralia catalog deadline exceeded');
        const lease = await this.prisma.$queryRawUnsafe<Array<{ owner: string }>>(
            `SELECT "owner" FROM "DoctoraliaCatalogLease"
             WHERE "connectionId"=$1 AND "owner"=$2 AND "expiresAt">NOW()`,
            connectionId, owner,
        );
        if (lease.length !== 1) {
            throw new Error('Doctoralia catalog lease lost');
        }
    }

    private async consumeAttempt(connectionId: string, owner: string, deadline: Date): Promise<void> {
        await this.assertLease(connectionId, owner, deadline);
        const rows = await this.prisma.$queryRawUnsafe<Array<{ attempts: number }>>(
            `INSERT INTO "DoctoraliaCatalogAttemptBucket" ("bucketStart","attempts","updatedAt")
             VALUES (date_trunc('hour',NOW()) + floor(date_part('minute',NOW())/15)*INTERVAL '15 minutes',1,NOW())
             ON CONFLICT ("bucketStart") DO UPDATE SET "attempts"="DoctoraliaCatalogAttemptBucket"."attempts"+1,"updatedAt"=NOW()
             WHERE "DoctoraliaCatalogAttemptBucket"."attempts" < 40
             RETURNING "attempts"`,
        );
        if (rows.length !== 1) throw new Error('Doctoralia catalog shared GET attempt budget exhausted');
    }
}