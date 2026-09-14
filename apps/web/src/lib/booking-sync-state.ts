export type BookingSyncStateInput = {
    origin?: string; status?: string; syncError?: string | null;
    vismedAppointmentId?: string | null; doctoraliaBookingId?: string | null; doctoraliaBreakId?: string | null;
    syncedToVismed?: boolean; syncedToDoctoralia?: boolean;
};

export function hasConfirmedDoctoraliaBreak(record: BookingSyncStateInput): boolean {
    return record.origin === 'VISMED'
        && record.status !== 'CANCELLED' && record.status !== 'FAILED'
        && !!record.doctoraliaBreakId && record.syncedToDoctoralia === true && !record.syncError;
}

export function getBookingSyncState(record: BookingSyncStateInput) {
    const doctoraliaBreakConfirmed = hasConfirmedDoctoraliaBreak(record);
    let syncedToVismed = record.syncedToVismed ?? !!record.vismedAppointmentId;
    // A booking identifier never overrides an explicitly pending operation.
    // A break identifier requires confirmation of its current state.
    let syncedToDoctoralia = record.doctoraliaBookingId
        ? (record.syncedToDoctoralia ?? true) : doctoraliaBreakConfirmed;
    if (record.syncError) {
        if (record.origin === 'VISMED' || /BREAK_OWNERSHIP_PENDING|BREAK_CONFLICT|VISMED_REFUSAL_CANCEL_PENDING/.test(record.syncError)) syncedToDoctoralia = false;
        if (record.origin === 'DOCTORALIA') syncedToVismed = false;
    }
    return { syncedToVismed, syncedToDoctoralia, doctoraliaBreakConfirmed };
}

export const bookingSyncState = getBookingSyncState;

export function bookingPendingNotice(record: BookingSyncStateInput): { title: string; detail: string } | null {
    const error = record.syncError || '';
    if (error.includes('VISMED_REFUSAL_CANCEL_PENDING')) return {
        title: 'Cancelamento na Doctoralia pendente',
        detail: 'A VISSMED recusou o horário. O cancelamento ainda precisa ser confirmado na Doctoralia; não informe ao paciente que a consulta está cancelada antes dessa conferência.',
    };
    if (/BREAK_OWNERSHIP_PENDING|BREAK_CONFLICT/.test(error)) return {
        title: 'Bloqueio preservado para conferência',
        detail: 'Não foi possível confirmar que o bloqueio pertence somente a este agendamento. A equipe deve conferir a associação antes de liberar ou movimentar o horário.',
    };
    if (error) return {
        title: 'Integração pendente de conferência',
        detail: 'Uma etapa da integração não foi concluída. Confira o resultado nos sistemas antes de repetir a operação ou confirmar o atendimento ao paciente.',
    };
    return null;
}
