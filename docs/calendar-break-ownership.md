# Evidência de criação dos bloqueios de agendamentos

## Comportamento

Agendamentos com origem VISMED criam bloqueios (breaks), não consultas com pacientes, na Doctoralia. Horários coincidentes não identificam o proprietário de um bloqueio. A recuperação por comparação de since/till foi retirada deste fluxo.

Antes de POST, uma entrada de controle em AuditLog registra a tentativa com chave primária calendar-break:<BookingSync.id>. Só a resposta direta com ID válido permite gravar o comprovante OWNED e associar o bloqueio. O comprovante inclui clínica, estabelecimento, médico, endereço e ID remoto, sem dados do paciente ou credenciais.

- 409: registra BREAK_CONFLICT, mantém syncedToDoctoralia=false e não adota bloqueio remoto.
- Timeout, rede, HTTP 5xx, resposta sem ID ou falha ao salvar o comprovante: a tentativa PENDING persiste. Novos polls não repetem POST até conferência operacional.
- Falha comprovadamente anterior ao envio ou rejeição HTTP 4xx: libera a tentativa para retry; não declara sucesso.
- Falha no update de BookingSync depois de salvar o comprovante: recupera exclusivamente o ID comprovado, deixa sincronização pendente e confere/move o horário no poll seguinte.
- PATCH/DELETE exigem comprovante no mesmo escopo e ausência de outro agendamento associado ao mesmo ID. Inclui cancelamento pelo dashboard.
- Associações antigas sem comprovante não são retroativamente certificadas. Se precisarem de alteração/cancelamento, preservam o bloqueio remoto e recebem BREAK_OWNERSHIP_PENDING. Registros já sincronizados e sem alteração continuam sem escrita remota.

## Banco e retorno

Sem alteração de schema, migration, dependências ou configuração. Usa a chave primária existente de AuditLog para busca e exclusão específicas, além dos campos já existentes doctoraliaBreakId/syncedToDoctoralia/syncError. Não executar limpeza dessa entrada operacional como descarte genérico de logs: isso elimina a evidência e volta a exigir conferência.

A versão anterior consegue ler o banco, mas ignora o comprovante e volta a permitir a adoção por horário. Retorno de imagem não desfaz bloqueios criados nem restaura proteção lógica. Não há migração automática das associações antigas nem correção de dados em produção neste pacote.

Conferência operacional de PENDING/legado exige evidência da operação original ou investigação específica; nunca certificar apenas porque existe um bloqueio no mesmo horário. Não apagar a tentativa para forçar retry sem confirmar que a criação anterior não aconteceu.

## Escopo e validação

O fluxo de bloqueios administrativos AdminBlockBreak é separado e não foi ativado ou modificado neste pacote. Não afirmar que sua reconciliação por horário foi corrigida por esta entrega.

36 testes do fluxo de bloqueios cobrem criação, conflitos, bloqueios manuais, múltiplos candidatos, timeout, rede, 5xx, payload inválido, falhas no banco, concorrência, cancelamento, legado, troca de mapeamento e retry de movimento por ID. Regressão conjunta: 9 suítes/212 testes passaram antes dos 6 últimos cenários adicionados (que passaram na suíte de 36). API TypeScript passou. Web: 16 testes passaram para os relatórios e resumo de execuções. Testes simulam Doctoralia; não criam agendamentos reais.

Integra os quatro ajustes de diagnóstico de agendas documentados em empty-agendas-diagnostics.md. Publicação e imagem devem ser registradas no documento operacional somente após execução verificada.
