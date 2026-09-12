# Diagnóstico de agendas sem disponibilidade

O evento SLOT_SYNC/skipped_empty indica ausência de payload de horários sem envio ou limpeza. Não comprova agenda interna bloqueada. O resumo mantém a contagem histórica, com a descrição “sem disponibilidade identificada”. A lista de agendas é consultada sob demanda no histórico já existente; falha tem mensagem e nova tentativa, e eventos antigos não recebem causa inventada.

Novos eventos incluem profissional, endereço e janela. O snapshot distingue profissional ausente nas respostas de profissional presente com lista vazia. Se houve faixa válida mas ela não gerou payload, a mensagem orienta conferir duração/limites. Os estados de limpeza gerenciada não foram alterados.

Formato de resposta desconhecido, profissional inválido, lista de horários ausente ou intervalo inválido agora marcam a categoria/data como incompleta. Isso impede substituição ou limpeza com base em dados descartados silenciosamente. A proteção é conservadora: um registro inválido afeta os médicos dessa categoria na janela. Não muda o contrato de envio Doctoralia, dependências ou schema.

## Contrato observado pela interface

GET /sync/:clinicId/history continua com autenticação e autorização existentes, sem novos parâmetros ou endpoints. A interface seleciona o ID da execução e usa events[].entityType/action/message. Campos e códigos HTTP não mudaram; o conteúdo textual dos novos eventos ficou mais descritivo. Eventos indisponíveis e falhas de consulta são exibidos explicitamente; falta parcial de eventos não vira lista completa por suposição.

## Validação local

- 30 testes: diagnóstico, respostas inválidas, ausência versus vazio, intervalos válidos, falha parcial de origem, preservação de agenda não gerenciada, limpeza autorizada e classificação de eventos.
- 26 testes de regressão: bloqueios, guardas de consistência e escopo de empresa.
- 5 testes de renderização do relatório: legado, pendências, listagem, histórico incompleto e contagem zero.
- TypeScript API e Web aprovados; build Web concluído (avisos já existentes de SWC/lockfile e Browserslist).
- Navegador local com fixture fictícia: expansão, falha simulada, mensagem de erro, nova tentativa e carga bem-sucedida com nome/endereço/período. Fixture removida; servidor de teste encerrado.

Não houve publicação, migração ou alteração de cadastros neste lote. Retorno do código não exige retorno de banco; eventos descritivos já escritos permaneceriam no histórico. A auditoria real das 22 agendas e seus limites está no relatório externo ao repositório AUDITORIA-22-AGENDAS-2026-09-12.md.

Conferência adicional do transporte HTTP: getScheduleDay preserva JSON null/false/0/string vazia para que o snapshot os rejeite como incompletos, em vez de normalizá-los para lista vazia. Bateria HTTP + disponibilidade + limpeza: 69 testes aprovados (inclui testes repetidos da primeira bateria). TypeScript API reconferido após essa alteração.
