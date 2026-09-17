# Integração somente de consultas

Regra aprovada: somente consultas participam do fluxo operacional VissMed ↔ Orquestrador ↔ Doctoralia. Exames, procedimentos e tipos desconhecidos não são novas entradas de agenda, não geram bloqueios, não são reenviados e não entram nos contadores operacionais.

## Contratos de origem

VissMed, confirmado em 17/09/2026 por leituras HTTP 200:

- GET /api/v1.0/get-agendamento-by-id?idagendamento=<id>: retorna tipo_servico e mostrarnadoctoralia, inclusive para profissional desabilitado.
- GET /api/v1.0/get-agendamento-filtros?unidade=<id>&dataini=DD/MM/AAAA&datafim=DD/MM/AAAA: retorna tipo_servico. A flag não veio nos itens observados; o fornecedor informa que a listagem filtra profissionais habilitados.
- Não usar sincronizar=1 em diagnóstico: esse parâmetro consome o feed.
- tipo_servico normalizado precisa ser Consulta. Campo ausente/desconhecido não autoriza sincronização. Flag explicitamente desabilitada impede mutações; ausência da flag não equivale a desabilitação.

Doctoralia: GET /api/v3/integration/services, consultado com OAuth configurado em 17/09/2026, respondeu HTTP 200 com id e name, sem categoria equivalente a tipo_servico. A classificação local é uma inferência revisada dos nomes canônicos, não um campo oferecido pelo fornecedor.

A lista explícita de 57 IDs do dicionário brasileiro está em apps/api/src/bookings/consultation-policy.ts. O vínculo usa DoctoraliaAddressService.service.doctoraliaServiceId, nunca o ID do serviço de endereço como ID do dicionário. Aplica-se somente ao domínio brasileiro configurado. Serviços novos, desconhecidos ou mistos ficam excluídos até revisão. Exemplos excluídos: Consulta + Exame de prevenção (5284), Consulta e prevenção (4821), Retorno sem cobrança (9978), Telemedicina II (5189). Não há classificação por substring em execução.

Referências: [objetos da API](https://integrations.docplanner.com/guide/api-objects/resources.html) e [documentação](https://integrations.docplanner.com/docs/). Ausência no escopo de diagnósticos não prova que um serviço é consulta.

## Aplicação e respostas

Ingestão, webhooks, criação manual, cancelamentos, remarcações, retries, varredura de segurança e reconciliação verificam a classificação antes de mutações. Slots usam somente serviços classificados como consulta; sem serviço elegível, não limpam a disponibilidade histórica. Leituras diretas, calendário e contadores aplicam a mesma política. O tipo VissMed prevalece sobre um serviço antigo da Doctoralia. Cache de classificação dura apenas o lote atual.

GET /api/booking-sync/records preserva autenticação, autorização por clínica, filtros e formato de lista. Retorna somente consultas, com appointmentType: "Consulta" e professionalDoctoraliaEnabled: boolean | null. Estatísticas usam a mesma classificação. Leituras de agenda Doctoralia acrescentam appointmentType: "Consulta" aos itens elegíveis. Exemplo parcial: { "appointmentType": "Consulta", "professionalDoctoraliaEnabled": true }. A mudança intencional é excluir itens não elegíveis, sem novos parâmetros, permissões ou formatos de erro/paginação.

Verificação pós-criação exige resposta VissMed explicitamente Consulta. Tipo diferente permanece não verificado, sem cancelamento automático. Desaparecimento da listagem não significa cancelamento: após tentar reconciliar substituição, exige consulta individual com ID correspondente, Consulta, profissional não explicitamente desabilitado e cancelado explícito.

## Histórico e limites

Não há exclusão de registros nem limpeza automática de bloqueios antigos. Quando registro existente recebe tipo excluído, apenas rawPayload é atualizado: status, IDs e vínculos são preservados. Nenhuma linha nova é criada para exame. Bloqueios reais permanecem no diagnóstico de conflito, mesmo com atendimento fora da agenda operacional.

Não agrupar IDs distintos por coincidência de paciente/horário. Bloqueios compartilhados exigem saneamento separado e autorizado. Este pacote não os libera na Doctoralia. Sem backfill ou monitoramento de todos os profissionais para descobrir desabilitações não entregues pela origem.

Sem mudanças em schema, dependências, timers, backoff ou rate limits. Verificações locais e consultas individuais podem acrescentar trabalho; não foi medida latência ponta a ponta. Todas as instâncias VissMed precisam entregar tipo_servico para seus registros serem elegíveis.

Nada publicado. Retornar o código não desfaz operações externas. Antes de publicar, verificar imagem em execução, rollback e PUBLICACAO.md. Evidências: [relatório de testes](testing/consultation-only.tdd.md).
