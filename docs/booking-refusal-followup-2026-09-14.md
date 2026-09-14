# Recusa definitiva da VISSMED e conferências de integração

Estado: desenvolvimento local sobre `183ec82ac74dcea13068a7467373ea0f3c7cb73d`, branch `codex/booking-refusal-followup`. Sem push ou publicação. Decisão da usuária em 14/09/2026: cancelar automaticamente na Doctoralia após confirmar a recusa definitiva.

## Comportamento

- No recebimento de `slot-booked`, somente a resposta concluída da criação com o corpo observado `{ "status": 402, "msg": "Horário indisponível, tente outro horários" }`, sem indicação de sucesso ou ID criado, inicia a compensação. `402` aqui é um campo do corpo, não classificação de um erro HTTP. Timeout, HTTP 4xx/5xx, texto de erro antigo e respostas contraditórias não autorizam cancelamento.
- O sistema grava um comprovante em `AuditLog`, confirma novamente a ausência da consulta na VISSMED e consulta o agendamento exato na Doctoralia: ID, unidade, médico, endereço e intervalo. Uma leitura inconclusiva, vínculo alterado ou consulta encontrada preserva a agenda e deixa conferência pendente.
- Antes do DELETE grava `REQUESTED`. Se o resultado ficar incerto, as próximas tentativas fazem conferência e não repetem a criação nem o cancelamento. Só um cancelamento aceito pela API ou identificado explicitamente na consulta permite concluir `CANCELLED`. GET 404 isolado não comprova cancelamento.
- Uma nova instância do serviço recupera o comprovante persistido; o marcador textual sem comprovante não autoriza uma escrita.
- O motivo de cancelamento enviado informa a recusa pela VISSMED. **A entrega de notificação ao paciente não foi verificada.** Não prometer WhatsApp, e-mail ou aviso no aplicativo.
- A regra cobre a criação recebida de Doctoralia. Não estende automaticamente essa política a falhas de reagendamento nem reprocessa recusas históricas em lote.

## Página de agendas

Preserva indicadores persistidos de sincronização: a simples existência de um ID não transforma uma operação pendente em sucesso. Adiciona conferências nos registros carregados, incluindo cancelamentos com erro, e explicação simples no detalhe. Não mostra mensagens técnicas brutas. A lista acompanha o conjunto carregado pela página; não é uma auditoria de todo o banco.

## Reconciliação de endereços

Agora as rotas consultadas vêm somente dos agendamentos elegíveis para aquela reconciliação, com unidade e endereço completos. Registros históricos contendo apenas bloqueios não fornecem rotas de consulta de agendamentos. Não foram alterados cadastros ou vínculos existentes.

Leitura em Petrópolis encontrou três combinações históricas ausentes das respostas atuais de endereços dos médicos, envolvendo quatro registros sem `doctoraliaBookingId`. Isso explica consultas desnecessárias; não prova a origem ou incorreção dos vínculos históricos.

## Verificações

- Produção, somente leitura em 14/09: ciclo completo de Petrópolis 06:39–06:46:38 (Brasília), 239 registros, zero erros, sete avisos e 22 agendas sem disponibilidade identificada; São Leopoldo também completou ciclo sem erros. Não é evidência de um novo teste ponta a ponta de agendamento.
- Dependências isoladas instaladas do lockfile; integrações externas simuladas e rede externa desabilitada nos testes. Nenhum agendamento real criado ou cancelado nesta etapa.
- Suíte geral: 1.154 testes passaram e 13 estavam ignorados. Houve 30 falhas por ausência de banco e quatro falhas de configuração nos testes existentes de Auth/Users. Estes arquivos e seus serviços não têm diferenças contra a base; não foram corrigidos dentro deste lote.
- Os 30 testes de banco foram executados novamente em PostgreSQL 16 descartável e passaram. Mais um teste real de persistência confirmou retomada de `REQUESTED`, sem repetir DELETE, e conclusão após cancelamento explícito.
- Validação final das três suítes diretamente afetadas: 122 testes passaram, incluindo resposta contraditória com ID e exclusão de rotas históricas indevidas.
- Os 20 testes de frontend passaram. TypeScript da API e do frontend passou em verificações separadas (o build Next do projeto ignora erros de tipagem). A validação visual interativa e a notificação da Doctoralia não foram realizadas.

## Banco e retorno de versão

Não muda schema, migração ou inicialização. Reutiliza `AuditLog` e `BookingSync`; grava estado operacional quando ocorrer uma recusa nova. Não exige limpeza de dados nem ajuste manual de vínculos.

**Retornar o código não desfaz cancelamentos externos.** A versão antiga não conhece o novo comprovante: antes de um rollback é necessário verificar se há compensações pendentes e impedir seu reprocessamento pelo código antigo, com procedimento de pausa aprovado. Não declarar compatibilidade operacional irrestrita só porque o schema não mudou. Identificar/preservar imagens e validar retorno e confirmação pertinente da infraestrutura na próxima janela, conforme AGENTS.md.

## Contratos

Sem novas rotas ou parâmetros HTTP. O resultado interno de `slot-booked` pode ser `cancelled_after_vismed_refusal`. O contrato existente de consulta de registros permanece; passa a expor `CANCELLED` após compensação confirmada ou `FAILED` com `VISMED_REFUSAL_CANCEL_PENDING` enquanto inconclusiva. `syncedToDoctoralia` descreve a conclusão da operação, não a entrega de mensagem ao paciente. `syncedToVismed` permanece falso quando a consulta foi recusada.
