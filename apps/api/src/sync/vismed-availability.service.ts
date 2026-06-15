import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { VismedService } from '../integrations/vismed/vismed.service';

export interface AvailRange {
    start: string; // "HH:MM"
    end: string;   // "HH:MM"
}

/**
 * Snapshot da disponibilidade real (scheduleDay) de uma clínica para uma janela de datas.
 * Guarda, por (idprofissional VisMed, data), as faixas de horário REALMENTE livres —
 * o que já reflete bloqueios de agenda feitos na VisMed (o turno bloqueado some daqui).
 *
 * Também rastreia, por (idcategoriaservico, data), se a chamada à VisMed teve sucesso.
 * Isso permite ao slot-sync decidir, de forma fail-safe, se a foto de um médico está
 * COMPLETA antes de substituir o calendário dele na Doctoralia (replaceSlots apaga tudo).
 */
export class ClinicAvailability {
    private ranges = new Map<string, AvailRange[]>();
    private fetchFailed = new Set<string>();

    private rangeKey(prof: number, date: string) {
        return `${prof}|${date}`;
    }
    private fetchKey(categoryId: number, date: string) {
        return `${categoryId}|${date}`;
    }

    setRanges(prof: number, date: string, ranges: AvailRange[]) {
        this.ranges.set(this.rangeKey(prof, date), ranges);
    }

    markFetchFailed(categoryId: number, date: string) {
        this.fetchFailed.add(this.fetchKey(categoryId, date));
    }

    getRanges(prof: number, date: string): AvailRange[] {
        return this.ranges.get(this.rangeKey(prof, date)) || [];
    }

    /**
     * A foto de um médico para uma data está completa se NENHUMA das categorias
     * (especialidades) dele teve falha de fetch naquela data.
     */
    isDateComplete(categoryIds: number[], date: string): boolean {
        for (const c of categoryIds) {
            if (this.fetchFailed.has(this.fetchKey(c, date))) return false;
        }
        return true;
    }

    /** True se TODAS as datas da janela estão completas para as categorias do médico. */
    isComplete(categoryIds: number[], dates: string[]): boolean {
        for (const d of dates) {
            if (!this.isDateComplete(categoryIds, d)) return false;
        }
        return true;
    }
}

@Injectable()
export class VismedAvailabilityService {
    private readonly logger = new Logger(VismedAvailabilityService.name);
    private readonly CONCURRENCY = 5;

    constructor(
        private prisma: PrismaService,
        private vismed: VismedService,
    ) {}

    private toMinutes(hhmm: string): number | null {
        const m = hhmm?.trim().match(/^(\d{1,2}):(\d{2})$/);
        if (!m) return null;
        const h = parseInt(m[1], 10);
        const min = parseInt(m[2], 10);
        if (h < 0 || h > 23 || min < 0 || min > 59) return null;
        return h * 60 + min;
    }

    private fromMinutes(total: number): string {
        const h = Math.floor(total / 60);
        const m = total % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }

    /**
     * Coalesce intervalos contíguos da VisMed (ex: 08:00-08:10, 08:10-08:20, ...)
     * em faixas amplas (ex: 08:00-12:00). Buracos (almoço, slot já agendado, turno
     * bloqueado) quebram a faixa em sub-faixas — comportamento correto.
     */
    coalesce(horarios: Array<{ inicio: string; fim: string }>): AvailRange[] {
        const intervals: Array<{ s: number; e: number }> = [];
        for (const h of horarios || []) {
            const s = this.toMinutes(h.inicio);
            const e = this.toMinutes(h.fim);
            if (s == null || e == null || e <= s) continue;
            intervals.push({ s, e });
        }
        if (intervals.length === 0) return [];
        intervals.sort((a, b) => a.s - b.s);

        const ranges: AvailRange[] = [];
        let curStart = intervals[0].s;
        let curEnd = intervals[0].e;
        for (let i = 1; i < intervals.length; i++) {
            const it = intervals[i];
            if (it.s <= curEnd) {
                // contíguo ou sobreposto → estende
                if (it.e > curEnd) curEnd = it.e;
            } else {
                ranges.push({ start: this.fromMinutes(curStart), end: this.fromMinutes(curEnd) });
                curStart = it.s;
                curEnd = it.e;
            }
        }
        ranges.push({ start: this.fromMinutes(curStart), end: this.fromMinutes(curEnd) });
        return ranges;
    }

    private async resolveConnection(clinicId: string): Promise<{ idEmpresaGestora: number; baseUrl?: string } | null> {
        const conn = await this.prisma.integrationConnection.findFirst({
            where: { clinicId, provider: 'vismed' },
        });
        if (!conn || !conn.clientId) return null;
        const idEmpresaGestora = Number(conn.clientId);
        if (isNaN(idEmpresaGestora)) return null;
        return { idEmpresaGestora, baseUrl: conn.domain || undefined };
    }

    /**
     * Constrói o snapshot de disponibilidade para um conjunto de especialidades
     * (idcategoriaservico) ao longo das datas informadas.
     */
    async buildForCategories(
        clinicId: string,
        categoryIds: number[],
        dates: string[],
    ): Promise<ClinicAvailability | null> {
        const conn = await this.resolveConnection(clinicId);
        if (!conn) {
            this.logger.warn(`[AVAIL] Clínica ${clinicId} sem conexão VisMed válida — disponibilidade não construída.`);
            return null;
        }

        const uniqueCategories = [...new Set(categoryIds.filter(c => Number.isInteger(c)))];
        const availability = new ClinicAvailability();
        if (uniqueCategories.length === 0) return availability;

        // (categoryId, date) acumulando intervalos por profissional antes de coalescer.
        const rawByProfDate = new Map<string, Array<{ inicio: string; fim: string }>>();

        const tasks: Array<{ categoryId: number; date: string }> = [];
        for (const c of uniqueCategories) {
            for (const d of dates) tasks.push({ categoryId: c, date: d });
        }

        this.logger.log(`[AVAIL] Construindo disponibilidade: ${uniqueCategories.length} especialidade(s) × ${dates.length} dia(s) = ${tasks.length} chamadas scheduleDay (clínica ${clinicId}).`);

        let idx = 0;
        const worker = async () => {
            while (idx < tasks.length) {
                const myIdx = idx++;
                const { categoryId, date } = tasks[myIdx];
                try {
                    const res: any = await this.vismed.getScheduleDay(conn.idEmpresaGestora, categoryId, date, conn.baseUrl);
                    const schedule: any[] = Array.isArray(res) ? res : (res?.schedule || res?.data || []);
                    for (const entry of schedule) {
                        const prof = Number(entry?.idprofissional ?? entry?.idProfissional ?? entry?.profissional);
                        if (!Number.isInteger(prof)) continue;
                        const key = `${prof}|${date}`;
                        const arr = rawByProfDate.get(key) || [];
                        const horarios = entry?.horarios ?? entry?.horários ?? entry?.slots ?? [];
                        for (const h of horarios) {
                            const inicio = h?.inicio ?? h?.início ?? h?.start;
                            const fim = h?.fim ?? h?.end;
                            if (inicio && fim) arr.push({ inicio: String(inicio), fim: String(fim) });
                        }
                        rawByProfDate.set(key, arr);
                    }
                } catch (err: any) {
                    availability.markFetchFailed(categoryId, date);
                    this.logger.warn(`[AVAIL] Falha scheduleDay categoria=${categoryId} data=${date}: ${err.message}`);
                }
            }
        };

        const workers = Array.from({ length: Math.min(this.CONCURRENCY, tasks.length) }, () => worker());
        await Promise.all(workers);

        // Coalesce por (prof, data)
        for (const [key, raw] of rawByProfDate.entries()) {
            const [profStr, date] = key.split('|');
            const prof = Number(profStr);
            availability.setRanges(prof, date, this.coalesce(raw));
        }

        return availability;
    }

    /** Resolve os idcategoriaservico de todos os médicos VisMed mapeados de uma clínica. */
    async getClinicCategoryIds(clinicId: string): Promise<number[]> {
        const clinicDoctorMappings = await this.prisma.mapping.findMany({
            where: { clinicId, entityType: 'DOCTOR' },
            select: { vismedId: true },
        });
        const clinicDoctorIds = clinicDoctorMappings.map(m => m.vismedId).filter(Boolean) as string[];
        if (clinicDoctorIds.length === 0) return [];

        const links = await this.prisma.vismedProfessionalSpecialty.findMany({
            where: { vismedDoctorId: { in: clinicDoctorIds } },
            include: { specialty: { select: { vismedId: true } } },
        });
        return [...new Set(links.map(l => l.specialty?.vismedId).filter((v): v is number => Number.isInteger(v as any)))];
    }

    /** Conveniência: constrói a disponibilidade de toda a clínica numa só passada. */
    async buildForClinic(clinicId: string, dates: string[]): Promise<ClinicAvailability | null> {
        const categoryIds = await this.getClinicCategoryIds(clinicId);
        return this.buildForCategories(clinicId, categoryIds, dates);
    }
}
