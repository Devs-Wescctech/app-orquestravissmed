import { PrismaService } from '../prisma/prisma.service';

export const REFUSAL_PENDING = 'VISMED_REFUSAL_CANCEL_PENDING';

/** Only the observed logical refusal from a completed create response qualifies. */
export function isDefinitiveSlotRefusal(body: any): boolean {
    if (!body || Array.isArray(body) || typeof body !== 'object') return false;
    if (body.success === true || body.sucesso === true || body.idpacienteagendamento || body.idPacienteAgendamento || body.id || body.data) return false;
    const message = typeof body.msg === 'string' ? body.msg.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase() : '';
    return body.status === 402 && message === 'horario indisponivel, tente outro horarios';
}

type Dependencies = {
    observedRefusal?: boolean;
    confirmAbsent: () => Promise<boolean>;
    getClient: () => Promise<any>;
    signal: AbortSignal;
};

/** Runs under the existing per-booking claim. Never replays an uncertain DELETE. */
export class VismedRefusalCancellation {
    constructor(private readonly prisma: PrismaService) {}

    async run(record: any, deps: Dependencies): Promise<void> {
        const fail = (reason: string): never => { throw new Error(`${REFUSAL_PENDING}: ${reason}`); };
        const checkClaim = () => { if (deps.signal.aborted) fail('posse da operação perdida; conferir cancelamento.'); };
        checkClaim();
        if (record.origin !== 'DOCTORALIA' || record.vismedAppointmentId || !record.doctoraliaBookingId
            || !record.doctoraliaFacilityId || !record.doctoraliaDoctorId || !record.doctoraliaAddressId) {
            fail('identificação incompleta ou agendamento já associado à VISSMED.');
        }
        const id = `vismed-refusal:${record.id}`;
        const scope = { clinicId: record.clinicId, vismedDoctorId: record.vismedDoctorId, bookingId: record.doctoraliaBookingId,
            facilityId: record.doctoraliaFacilityId, doctorId: record.doctoraliaDoctorId,
            addressId: record.doctoraliaAddressId, startAt: new Date(record.startAt).toISOString(),
            endAt: new Date(record.endAt).toISOString() };
        let receipt = await this.prisma.auditLog.findUnique({ where: { id } });
        if (receipt && (receipt.action !== 'VISMED_SLOT_REFUSAL' || receipt.entityId !== record.id
            || Object.entries(scope).some(([key, value]) => (receipt!.details as any)?.[key] !== value))) {
            fail('comprovante diverge do agendamento; nenhuma alteração enviada.');
        }
        if (!receipt) {
            if (!deps.observedRefusal) fail('comprovante da recusa não localizado; cancelamento não autorizado.');
            // Persist intent before any remote cancellation; historical errors do not enter here automatically.
            await this.prisma.$transaction(async tx => {
                receipt = await tx.auditLog.create({ data: { id, entity: 'BookingSync', entityId: record.id,
                    action: 'VISMED_SLOT_REFUSAL', details: { ...scope, state: 'REFUSED' } } });
                await tx.bookingSync.update({ where: { id: record.id }, data: { status: 'FAILED',
                    syncedToVismed: false, syncedToDoctoralia: false,
                    syncError: `${REFUSAL_PENDING}: VISSMED recusou o horário; cancelamento na Doctoralia em verificação.` } });
            });
        }
        const finish = async () => {
            await this.prisma.bookingSync.update({ where: { id: record.id }, data: {
                status: 'CANCELLED', cancelledBy: 'INTEGRATION', cancelledAt: record.cancelledAt || new Date(),
                syncedToDoctoralia: true, syncedToVismed: false,
                syncError: null, processedAt: new Date(),
            } });
        };
        const state = (receipt!.details as any).state;
        if (state === 'CONFIRMED') { await finish(); return; }
        if (!['REFUSED', 'REQUESTED'].includes(state)) fail('estado do comprovante inválido.');
        checkClaim();
        if (!await deps.confirmAbsent()) fail('não foi possível confirmar ausência da consulta na VISSMED.');
        const client = await deps.getClient();
        const args = [scope.facilityId, scope.doctorId, scope.addressId, scope.bookingId];
        let remote: any;
        try { remote = await client.getBooking(...args); }
        catch { fail('não foi possível conferir a consulta na Doctoralia.'); }
        if (String(remote?.id) !== scope.bookingId || Date.parse(remote?.start_at) !== Date.parse(scope.startAt)
            || Date.parse(remote?.end_at) !== Date.parse(scope.endAt)) fail('consulta remota mudou ou não foi identificada com segurança.');
        const cancelled = ['CANCELLED', 'CANCELED', 'DELETED'].includes(String(remote?.status).toUpperCase())
            || !!remote?.cancelled_at || !!remote?.canceled_at;
        if (!cancelled) {
            if (state === 'REQUESTED') fail('resultado anterior incerto; cancelamento não será repetido automaticamente.');
            if (!['BOOKED', 'CONFIRMED', 'SCHEDULED'].includes(String(remote?.status).toUpperCase())) fail('situação remota não permite cancelamento seguro.');
            checkClaim();
            await this.prisma.auditLog.update({ where: { id }, data: { details: { ...scope, state: 'REQUESTED' } } });
            checkClaim();
            try { await client.cancelBooking(...args, 'Horário recusado pela VISSMED; consulta não confirmada na clínica.'); }
            catch { fail('Doctoralia não confirmou o cancelamento; conferir o resultado antes de repetir.'); }
        }
        await this.prisma.auditLog.update({ where: { id }, data: { details: { ...scope, state: 'CONFIRMED' } } });
        await finish();
    }
}
