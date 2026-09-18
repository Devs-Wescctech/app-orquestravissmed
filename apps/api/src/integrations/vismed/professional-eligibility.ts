import { PrismaService } from '../../prisma/prisma.service';
import { VismedService } from './vismed.service';

export type Eligibility = { state: 'enabled' | 'excluded' | 'unknown'; reason: string };
const flag = (value: unknown): boolean | null => value === 1 || value === '1' || value === true ? true
    : value === 0 || value === '0' || value === false ? false : null;
const numericId = (value: unknown): number | null => /^(?:[1-9]\d*)$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? Number(value) : null;

/** Fresh read. Availability, names and old local mappings never authorize publication. */
export class ProfessionalEligibility {
    constructor(private readonly prisma: PrismaService, private readonly vismed: VismedService) {}

    async check(clinicId: string, professionalId: number): Promise<Eligibility> {
        const unknown = (reason: string): Eligibility => ({ state: 'unknown', reason });
        if (!clinicId || !numericId(professionalId)) return unknown('missing_identity');
        try {
            const conn = await this.prisma.integrationConnection.findFirst({ where: { clinicId, provider: 'vismed' } });
            if (!conn?.domain || !numericId(conn.clientId) || conn.status === 'disconnected') return unknown('invalid_connection');
            const url = new URL(conn.domain.includes('://') ? conn.domain : `https://${conn.domain}`);
            // VISSMED confirmed this instance's professionals route filters eligibility.
            // Its current contract is a plain array; pagination/envelopes fail closed below.
            // Do not extrapolate that contract to other deployments.
            const filteredRoster = url.hostname === 'app.vissmed.com.br'
                && /^\/api-docctor-3(?:\/api\/v1\.0)?\/?$/i.test(url.pathname);
            const rows = await this.vismed.getProfissionaisForEligibility(Number(conn.clientId), conn.domain);
            if (!Array.isArray(rows)) return unknown('invalid_roster');
            const byId = new Map<number, any>();
            for (const row of rows) {
                if (!row || typeof row !== 'object' || Array.isArray(row)) return unknown('invalid_roster');
                const id = numericId(row.idprofissional ?? row.id);
                if (!id || byId.has(id) || (row.id != null && numericId(row.id) !== id)
                    || (row.idempresagestora != null && Number(row.idempresagestora) !== Number(conn.clientId))) return unknown('ambiguous_roster');
                byId.set(id, row);
            }
            const row = byId.get(Number(professionalId));
            if (!row) return filteredRoster ? { state: 'excluded', reason: 'absent_from_filtered_roster' } : unknown('unconfirmed_roster_contract');
            if (flag(row.ativo) === false || flag(row.mostrarnadoctoralia) === false) return { state: 'excluded', reason: 'explicitly_disabled' };
            if (('mostrarnadoctoralia' in row && flag(row.mostrarnadoctoralia) === null)
                || ('ativo' in row && flag(row.ativo) === null)) return unknown('invalid_flag');
            if (flag(row.mostrarnadoctoralia) === true || filteredRoster) return { state: 'enabled', reason: 'confirmed_roster' };
            return unknown('unconfirmed_roster_contract');
        } catch {
            // Never turn timeout, malformed JSON, HTTP error or missing configuration into an empty roster.
            return unknown('roster_unavailable');
        }
    }
}
