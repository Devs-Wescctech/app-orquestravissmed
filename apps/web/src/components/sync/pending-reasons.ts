export interface PendingEvent { action: string; message?: string | null }

export function explainPendingReasons(events: readonly PendingEvent[]) {
    const groups = [
        { actions: ['plan_pending', 'regression_warning'], title: 'Convênios e planos precisam de conferência',
            meaning: 'Alguns convênios estão sem plano confirmado na Doctoralia. O mesmo caso pode gerar avisos para vários profissionais.',
            next: 'Confira se o convênio está correto e quais planos ele oferece. Se não houver planos no catálogo, confirme a regra com a Doctoralia antes de escolher ou remover vínculos.' },
        { actions: ['skipped_no_approved_mapping', 'skipped_pending_review', 'skipped_override_invalid'], title: 'Serviços precisam de um vínculo confirmado',
            meaning: 'O sistema não encontrou um vínculo aprovado e utilizável entre uma especialidade da VISSMED e um serviço da Doctoralia. A atualização desses itens ficou limitada.',
            next: 'Na Central de Mapeamento, confira o procedimento atendido pelo profissional antes de aprovar o vínculo.' },
        { actions: ['managed_scope_pending'], title: 'Remoção de horários aguardando conferência',
            meaning: 'O sistema não conseguiu comprovar quais intervalos poderia remover com segurança e preservou os horários.',
            next: 'Solicite à equipe responsável a comparação das duas agendas e do histórico da integração. Não exclua horários apenas para eliminar o aviso.' },
        { actions: ['mapping_pending'], title: 'Vínculo da agenda precisa de conferência',
            meaning: 'O vínculo necessário para atualizar a agenda ainda não está confirmado.',
            next: 'Confira o profissional e a unidade na Central de Mapeamento.' },
        { actions: ['skipped_incomplete'], title: 'Não foi possível obter toda a disponibilidade',
            meaning: 'A consulta à origem ficou incompleta. A agenda foi preservada para evitar uma atualização com dados insuficientes.',
            next: 'Confira as próximas execuções. Se o aviso persistir, solicite a análise da conexão e da resposta da VISSMED.' },
    ];
    return groups.map(group => ({ ...group, events: events.filter(event => group.actions.includes(event.action)) }))
        .filter(group => group.events.length > 0);
}
