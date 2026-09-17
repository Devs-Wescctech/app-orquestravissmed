/** Metadata supplied by VissMed. Missing fields must not imply consultation or cancellation. */
export function vismedAppointmentMetadata(payload: unknown) {
    const raw = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload as Record<string, unknown> : {};
    const type = typeof raw.tipo_servico === 'string' ? raw.tipo_servico.trim().toLowerCase() : '';
    const labels: Record<string, string> = { consulta: 'Consulta', exame: 'Exame', procedimento: 'Procedimento' };
    const flag = raw.mostrarnadoctoralia;
    return {
        appointmentType: Object.prototype.hasOwnProperty.call(labels, type) ? labels[type] : null,
        professionalDoctoraliaEnabled: flag === '1' || flag === 1 || flag === true ? true
            : flag === '0' || flag === 0 || flag === false ? false : null,
    };
}
