export function getAlertHeading(total: number, groups: Array<{ reason?: string }>): string {
    const plural = total !== 1;
    const prefix = `${total} agendamento${plural ? 's' : ''}`;
    if (groups.length && groups.every(g => g.reason === 'VISMED_CREATE_FAILED')) {
        return `${prefix} não confirmado${plural ? 's' : ''} na VissMed`;
    }
    if (groups.length && groups.every(g => g.reason === 'DOCTOR_NOT_LINKED')) {
        return `${prefix} não enviado${plural ? 's' : ''} à Doctoralia`;
    }
    return `${prefix} com pendência de sincronização`;
}

export function getAlertPresentation(reason?: string, error?: string | null) {
    if (error?.includes('VISMED_REFUSAL_CANCEL_PENDING')) {
        return {
            title: 'Cancelamento na Doctoralia pendente',
            description: 'A VISSMED recusou o horário. Aguarde a confirmação do cancelamento na Doctoralia antes de informar ao paciente que a consulta foi cancelada.',
            needsMapping: false,
        };
    }
    if (reason === 'DOCTOR_NOT_LINKED') {
        return {
            title: 'Médico sem vínculo com a Doctoralia',
            description: 'Confira o vínculo do profissional na Central de Mapeamento para permitir o envio à Doctoralia.',
            needsMapping: true,
        };
    }
    if (reason === 'VISMED_CREATE_FAILED') {
        const normalized = (error || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        const unavailable = /horario\s+indisponivel/.test(normalized);
        return {
            title: unavailable ? 'Horário indisponível na VissMed' : 'Agendamento não confirmado na VissMed',
            description: unavailable
                ? 'A VissMed informou que o horário está indisponível. Confira as duas agendas antes de escolher outro horário.'
                : 'A VissMed não confirmou a criação. Confira o agendamento nas duas agendas e o diagnóstico antes de tentar novamente.',
            needsMapping: false,
        };
    }
    return {
        title: 'Pendência de sincronização',
        description: 'Confira os dados do agendamento e o diagnóstico disponível para identificar a causa.',
        needsMapping: false,
    };
}
