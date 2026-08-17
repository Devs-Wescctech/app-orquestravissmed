import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Status do vínculo bloqueio↔break.
 * Definido localmente para não depender do Prisma Client gerado em tempo de teste/compilação.
 * Deve espelhar o enum AdminBlockBreakStatus do schema.prisma.
 */
export const AdminBlockBreakStatus = {
    ACTIVE: 'ACTIVE',
    CANCELLED: 'CANCELLED',
} as const;
export type AdminBlockBreakStatus = (typeof AdminBlockBreakStatus)[keyof typeof AdminBlockBreakStatus];

/**
 * Chave natural que identifica um bloqueio VisMed de forma determinística.
 *
 * - idprofissional + dataagendamento + horarioagendamento formam o identificador
 *   estável do bloqueio (o horário final é malformado no VisMed e portanto excluído).
 * - addressId distingue os N breaks Doctoralia de um mesmo bloqueio (1 por endereço).
 *   Use '' (empty string) como sentinela quando o endereço ainda não é conhecido
 *   (ex.: snapshot do BlockWatcher antes de WP3 vincular a um break Doctoralia).
 */
export interface BlockNaturalKey {
    clinicId: string;
    idprofissional: number;
    dataagendamento: string;  // "YYYY-MM-DD" ou formato VisMed
    horarioagendamento: string; // HH:mm — início (confiável)
    addressId: string;
}

/**
 * Dados completos necessários para criar ou atualizar um vínculo.
 *
 * - `rawEndTime`: valor bruto de `horarioagendamentofinal` vindo da API VisMed.
 *   Pode estar malformado (ex.: "012:0"). Usado para calcular `periodHash` via
 *   `computeBlockPeriodHash` e para reconstruir o hash agregado por médico na
 *   recuperação pós-restart do BlockWatcher.
 * - `periodHash`: se fornecido pelo chamador (pré-calculado), é usado diretamente;
 *   caso contrário, é calculado a partir de `rawEndTime` + chave natural (raw hash).
 *   Se `rawEndTime` também não estiver disponível, cai para hash derivado de datas.
 */
export interface BlockBreakUpsertData extends BlockNaturalKey {
    periodStart: Date;
    periodEnd: Date;
    facilityId: string;
    rawEndTime?: string | null;
    doctoraliaBreakId?: string | null;
    status?: AdminBlockBreakStatus;
    /** Pré-calculado pelo chamador (opcional). Quando presente, ignoramos rawEndTime/datas. */
    periodHash?: string;
}

/**
 * Calcula o hash determinístico do período de um bloqueio VisMed a partir dos
 * campos RAW da API.
 *
 * Usa os valores brutos (horarioagendamento + horarioagendamentofinal + dataagendamento)
 * para que qualquer mudança de horário seja detectada imediatamente, mesmo que o
 * horário final seja malformado. Este é o hash canônico de um bloco individual.
 *
 * Segue o mesmo padrão do `hashBlocks` do BlockWatcherService: SHA-256 hex de um
 * JSON canônico com `d`, `i`, `f` stringificados.
 */
export function computeBlockPeriodHash(params: {
    horarioagendamento: string;
    horarioagendamentofinal: string;
    dataagendamento: string;
}): string {
    const canonical = JSON.stringify({
        d: String(params.dataagendamento ?? ''),
        i: String(params.horarioagendamento ?? ''),
        f: String(params.horarioagendamentofinal ?? ''),
    });
    return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Reconstrói o hash agregado por médico (mesmo algoritmo do BlockWatcher.hashBlocks)
 * a partir de uma lista de registros AdminBlockBreak armazenados no banco.
 *
 * Usado na recuperação pós-restart para pré-popular o snapshot em memória.
 */
export function reconstructDoctorHash(
    records: Array<{ dataagendamento: string; horarioagendamento: string; rawEndTime?: string | null }>,
): string {
    const norm = records
        .map(r => ({
            d: String(r.dataagendamento ?? ''),
            i: String(r.horarioagendamento ?? ''),
            f: String(r.rawEndTime ?? ''),
        }))
        .sort((a, b) => (a.d + a.i + a.f).localeCompare(b.d + b.i + b.f));
    return crypto.createHash('sha256').update(JSON.stringify(norm)).digest('hex');
}

@Injectable()
export class AdminBlockBreakService {
    constructor(private readonly prisma: PrismaService) {}

    /**
     * Upsert idempotente de um vínculo bloqueio↔break.
     *
     * - Se o registro não existe, cria.
     * - Se já existe, atualiza apenas os campos mutáveis (período, hash, breakId, status).
     * - A chave natural (clinicId + idprofissional + dataagendamento + horarioagendamento
     *   + addressId) nunca muda — é a identidade do vínculo.
     *
     * Idempotente: chamar com os mesmos dados retorna o mesmo resultado sem efeitos
     * colaterais adicionais.
     *
     * O `periodHash` segue a seguinte prioridade:
     *   1. Usa `data.periodHash` se fornecido explicitamente.
     *   2. Calcula via `computeBlockPeriodHash` se `rawEndTime` estiver presente.
     *   3. Deriva de `periodStart`/`periodEnd` ISO strings (fallback).
     */
    async upsert(data: BlockBreakUpsertData) {
        const {
            clinicId,
            idprofissional,
            dataagendamento,
            horarioagendamento,
            addressId,
            periodStart,
            periodEnd,
            facilityId,
            rawEndTime = null,
            doctoraliaBreakId = null,
            status = AdminBlockBreakStatus.ACTIVE,
        } = data;

        const periodHash = data.periodHash
            ?? (rawEndTime !== null && rawEndTime !== undefined
                ? computeBlockPeriodHash({ horarioagendamento, horarioagendamentofinal: rawEndTime, dataagendamento })
                : this.computeHashFromDates(periodStart, periodEnd));

        return this.prisma.adminBlockBreak.upsert({
            where: {
                clinicId_idprofissional_dataagendamento_horarioagendamento_addressId: {
                    clinicId,
                    idprofissional,
                    dataagendamento,
                    horarioagendamento,
                    addressId,
                },
            },
            create: {
                clinicId,
                idprofissional,
                dataagendamento,
                horarioagendamento,
                addressId,
                rawEndTime,
                periodStart,
                periodEnd,
                periodHash,
                facilityId,
                doctoraliaBreakId,
                status,
            },
            update: {
                rawEndTime,
                periodStart,
                periodEnd,
                periodHash,
                facilityId,
                doctoraliaBreakId,
                status,
                lastSyncAttemptAt: new Date(),
            },
        });
    }

    /**
     * Consulta todos os vínculos ativos de uma clínica.
     * Usado pelo diff para detectar bloqueios que desapareceram da VisMed.
     */
    async findActiveByClinic(clinicId: string) {
        return this.prisma.adminBlockBreak.findMany({
            where: { clinicId, status: AdminBlockBreakStatus.ACTIVE },
        });
    }

    /**
     * Consulta todos os vínculos ativos de um médico em uma clínica.
     * Usado pelo diff direcionado (por idprofissional).
     */
    async findActiveByDoctor(clinicId: string, idprofissional: number) {
        return this.prisma.adminBlockBreak.findMany({
            where: { clinicId, idprofissional, status: AdminBlockBreakStatus.ACTIVE },
        });
    }

    /**
     * Busca um vínculo pela chave natural exata.
     * Retorna null se não existe.
     */
    async findByNaturalKey(key: BlockNaturalKey) {
        return this.prisma.adminBlockBreak.findUnique({
            where: {
                clinicId_idprofissional_dataagendamento_horarioagendamento_addressId: {
                    clinicId: key.clinicId,
                    idprofissional: key.idprofissional,
                    dataagendamento: key.dataagendamento,
                    horarioagendamento: key.horarioagendamento,
                    addressId: key.addressId,
                },
            },
        });
    }

    /**
     * Carrega o snapshot por médico de uma clínica para recuperação pós-restart.
     *
     * Retorna um Map<idprofissional, hash> onde o hash é o mesmo calculado por
     * BlockWatcher.hashBlocks — garante que o primeiro ciclo pós-restart não
     * trate todos os médicos como "alterados" desnecessariamente.
     *
     * Considera apenas registros com addressId='' (sentinela de snapshot BlockWatcher)
     * e status ACTIVE.
     */
    async loadSnapshotForClinic(clinicId: string): Promise<Map<number, string>> {
        const records = await this.prisma.adminBlockBreak.findMany({
            where: { clinicId, addressId: '', status: AdminBlockBreakStatus.ACTIVE },
            select: { idprofissional: true, dataagendamento: true, horarioagendamento: true, rawEndTime: true },
        });

        // Agrupa por médico e recalcula o hash agregado.
        const byDoctor = new Map<number, typeof records>();
        for (const r of records) {
            if (!byDoctor.has(r.idprofissional)) byDoctor.set(r.idprofissional, []);
            byDoctor.get(r.idprofissional)!.push(r);
        }

        const snapshot = new Map<number, string>();
        for (const [id, list] of byDoctor) {
            snapshot.set(id, reconstructDoctorHash(list));
        }
        return snapshot;
    }

    /**
     * Marca um vínculo como CANCELLED (soft delete idempotente).
     * Não remove o registro — preserva histórico e permite auditoria.
     * Retorna null se o registro não existia (não lança).
     */
    async cancel(key: BlockNaturalKey) {
        try {
            return await this.prisma.adminBlockBreak.update({
                where: {
                    clinicId_idprofissional_dataagendamento_horarioagendamento_addressId: {
                        clinicId: key.clinicId,
                        idprofissional: key.idprofissional,
                        dataagendamento: key.dataagendamento,
                        horarioagendamento: key.horarioagendamento,
                        addressId: key.addressId,
                    },
                },
                data: {
                    status: AdminBlockBreakStatus.CANCELLED,
                    lastSyncAttemptAt: new Date(),
                },
            });
        } catch (err: any) {
            // P2025 = record not found — idempotente: já cancelado ou nunca existiu
            if (err?.code === 'P2025') return null;
            throw err;
        }
    }

    /**
     * Cancela todos os vínculos ACTIVE de um médico em uma clínica.
     * Útil quando o bloqueio some completamente da VisMed (todos os endereços).
     */
    async cancelAllForDoctor(clinicId: string, idprofissional: number) {
        return this.prisma.adminBlockBreak.updateMany({
            where: {
                clinicId,
                idprofissional,
                status: AdminBlockBreakStatus.ACTIVE,
            },
            data: {
                status: AdminBlockBreakStatus.CANCELLED,
                lastSyncAttemptAt: new Date(),
            },
        });
    }

    /**
     * Carrega todos os snapshots do banco para todas as clínicas.
     * Usado pelo BlockWatcher no onModuleInit para recuperação pós-restart.
     * Retorna Map<clinicId, Map<idprofissional, hash>>.
     */
    async loadAllSnapshots(): Promise<Map<string, Map<number, string>>> {
        const records = await this.prisma.adminBlockBreak.findMany({
            where: { addressId: '', status: AdminBlockBreakStatus.ACTIVE },
            select: {
                clinicId: true,
                idprofissional: true,
                dataagendamento: true,
                horarioagendamento: true,
                rawEndTime: true,
            },
        });

        // Agrupa por clínica e, dentro de cada clínica, por médico.
        const byClinic = new Map<string, Map<number, Array<{ dataagendamento: string; horarioagendamento: string; rawEndTime: string | null }>>>();
        for (const r of records) {
            if (!byClinic.has(r.clinicId)) byClinic.set(r.clinicId, new Map());
            const byDoc = byClinic.get(r.clinicId)!;
            if (!byDoc.has(r.idprofissional)) byDoc.set(r.idprofissional, []);
            byDoc.get(r.idprofissional)!.push(r);
        }

        const result = new Map<string, Map<number, string>>();
        for (const [clinicId, byDoc] of byClinic) {
            const docMap = new Map<number, string>();
            for (const [idprofissional, blocks] of byDoc) {
                docMap.set(idprofissional, reconstructDoctorHash(blocks));
            }
            result.set(clinicId, docMap);
        }
        return result;
    }

    /**
     * Cancela todos os vínculos ACTIVE de um médico com addressId='' (sentinela de snapshot).
     * Específico para o BlockWatcher: limpa registros de snapshot sem tocar vínculos reais.
     */
    async cancelSnapshotForDoctor(clinicId: string, idprofissional: number) {
        return this.prisma.adminBlockBreak.updateMany({
            where: {
                clinicId,
                idprofissional,
                addressId: '',
                status: AdminBlockBreakStatus.ACTIVE,
            },
            data: {
                status: AdminBlockBreakStatus.CANCELLED,
                lastSyncAttemptAt: new Date(),
            },
        });
    }

    /**
     * Reconcilia os registros de snapshot (addressId='') de um médico com o conjunto
     * de bloqueios actuais da VisMed.
     *
     * Problema que resolve: quando um médico passa de bloqueios {A,B} para {B,C},
     * o bloco A permanece ACTIVE no banco se não for explicitamente cancelado.
     * Na recuperação pós-restart, loadAllSnapshots leria A+B+C e divergiria de
     * B+C, causando um re-sync desnecessário a cada restart.
     *
     * Algoritmo:
     *   1. Carrega todos os registros ACTIVE do médico com addressId=''.
     *   2. Identifica os que não estão em `currentBlocks` (chave: date+startTime).
     *   3. Cancela apenas esses (preserva os que permanecem activos).
     *
     * É idempotente: chamar com o mesmo currentBlocks não muda nada se os registros
     * já estão no estado correcto.
     */
    async reconcileSnapshotForDoctor(
        clinicId: string,
        idprofissional: number,
        currentBlocks: Array<{ dataagendamento: string; horarioagendamento: string }>,
    ): Promise<{ cancelledCount: number }> {
        const existing = await this.prisma.adminBlockBreak.findMany({
            where: { clinicId, idprofissional, addressId: '', status: AdminBlockBreakStatus.ACTIVE },
            select: { id: true, dataagendamento: true, horarioagendamento: true },
        });

        const currentKeySet = new Set(
            currentBlocks.map(b => `${b.dataagendamento}|${b.horarioagendamento}`),
        );

        const staleIds = existing
            .filter(r => !currentKeySet.has(`${r.dataagendamento}|${r.horarioagendamento}`))
            .map(r => r.id);

        if (staleIds.length === 0) return { cancelledCount: 0 };

        await this.prisma.adminBlockBreak.updateMany({
            where: { id: { in: staleIds } },
            data: { status: AdminBlockBreakStatus.CANCELLED, lastSyncAttemptAt: new Date() },
        });
        return { cancelledCount: staleIds.length };
    }

    /**
     * Hash determinístico derivado das datas normalizadas do período.
     * Fallback quando os campos raw da VisMed não estão disponíveis.
     */
    private computeHashFromDates(start: Date, end: Date): string {
        const canonical = JSON.stringify({
            s: start.toISOString(),
            e: end.toISOString(),
        });
        return crypto.createHash('sha256').update(canonical).digest('hex');
    }
}
