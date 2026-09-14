export type RelatedBooking = {
    id: string; patientName: string; startAt: string; endAt: string;
    status: string; synchronized: boolean;
};
export type ConflictDetails = {
    checkedAt: string; availability: 'complete' | 'partial' | 'unavailable'; reason?: string;
    overlaps: Array<{ startAt: string; endAt: string; relatedBookings: RelatedBooking[] }>;
    sameNameBookings: RelatedBooking[];
};
const time = (value: string) => new Date(value).toLocaleTimeString('pt-BR', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
});

export function conflictExplanation(data?: ConflictDetails): string[] {
    if (!data) return ['Consultando os bloqueios e agendamentos relacionados…'];
    const lines = data.overlaps.map(b => {
        const count = b.relatedBookings.length;
        return `Existe bloqueio das ${time(b.startAt)} às ${time(b.endAt)} na Doctoralia` + (count
            ? `, associado no orquestrador a ${count} outro${count === 1 ? '' : 's'} agendamento${count === 1 ? '' : 's'}.`
            : '. Não foi encontrada associação com outro agendamento neste endereço e nesta clínica.');
    });
    if (data.sameNameBookings.length) {
        const count = data.sameNameBookings.length;
        const synced = data.sameNameBookings.filter(b => b.synchronized).length;
        lines.push(`Há ${count} outro${count === 1 ? '' : 's'} registro${count === 1 ? '' : 's'} com o mesmo nome, médico e horário, mas IDs de agendamento VissMed diferentes. ${synced} com sincronização confirmada. Isso não comprova duplicidade; confira os registros.`);
    }
    if (data.availability === 'unavailable') lines.push(data.reason || 'Não foi possível consultar a Doctoralia. A causa específica permanece sem confirmação.');
    if (data.availability === 'partial') lines.push('A consulta da Doctoralia está incompleta; podem existir outros bloqueios.');
    if (data.availability === 'complete' && !data.overlaps.length) lines.push('Nenhum bloqueio sobreposto foi encontrado nesta consulta. Isso não confirma que a pendência registrada foi resolvida.');
    return lines;
}
