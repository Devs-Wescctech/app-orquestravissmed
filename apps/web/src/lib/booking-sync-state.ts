export interface BookingSyncStateInput {
    origin: string;
    status: string;
    vismedAppointmentId?: string | null;
    doctoraliaBookingId?: string | null;
    doctoraliaBreakId?: string | null;
    syncedToDoctoralia?: boolean;
    syncError?: string | null;
}

export function hasConfirmedDoctoraliaBreak(record: BookingSyncStateInput): boolean {
    // An existing break can still await a move/reconciliation. Its ID alone
    // does not confirm that it protects the current appointment time.
    return record.origin === 'VISMED'
        && record.status !== 'CANCELLED'
        && record.status !== 'FAILED'
        && !!record.doctoraliaBreakId
        && record.syncedToDoctoralia === true
        && !record.syncError;
}

export function getBookingSyncState(record: BookingSyncStateInput) {
    const doctoraliaBreakConfirmed = hasConfirmedDoctoraliaBreak(record);
    return {
        doctoraliaBreakConfirmed,
        syncedToVismed: !!record.vismedAppointmentId,
        syncedToDoctoralia: !!record.doctoraliaBookingId || doctoraliaBreakConfirmed,
    };
}
