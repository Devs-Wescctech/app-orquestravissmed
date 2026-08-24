export type VismedAppointmentFeedMode = 'LEGACY' | 'INCREMENTAL';

export type VismedAppointmentFeedModeResolution = {
    mode: VismedAppointmentFeedMode;
    invalidConfiguration: boolean;
};

/**
 * Somente INCREMENTAL explícito altera a semântica do polling. A coluna é
 * nullable de propósito para que instalações existentes continuem no contrato
 * snapshot sem backfill ou ativação implícita.
 */
export function normalizeVismedAppointmentFeedMode(
    rawMode: unknown,
): VismedAppointmentFeedModeResolution {
    if (rawMode === null || rawMode === undefined || rawMode === 'LEGACY') {
        return { mode: 'LEGACY', invalidConfiguration: false };
    }

    if (rawMode === 'INCREMENTAL') {
        return { mode: 'INCREMENTAL', invalidConfiguration: false };
    }

    return { mode: 'LEGACY', invalidConfiguration: true };
}