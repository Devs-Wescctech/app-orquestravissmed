# Classificação de agendamentos antigos da Vissmed

## Diagnóstico somente de leitura em 23/09/2026

Entre 22.839 `BookingSync` da Vissmed criados antes de 18/09, 22.188 ainda não tinham `tipo_servico` reconhecido no payload local. Destes, 353 eram atendimentos ativos futuros e 121 mantinham `doctoraliaBreakId`. Outros 21.761 já tinham horário passado. As quantidades são um instantâneo e não autorizam mutação em lote.

O filtro em `consultation-policy.ts` já exclui payload Vissmed sem tipo dos processos de consulta. Isso evita processar um exame como consulta, mas pode deixar uma consulta antiga fora das leituras e da sincronização até sua classificação. Oito consultas individuais pelo contrato `get-agendamento-by-id` retornaram sete `Consulta` e um `Procedimento`, com ID correspondente. Nos quatro exemplos com bloqueio verificados em detalhe, profissional e início também corresponderam ao registro local. Portanto, a classificação precisa vir do ID individual na Vissmed, não do serviço Doctoralia, do horário ou de um bloqueio existente.

## Tratamento preparado

O utilitário `apps/api/scripts/backfill-legacy-appointment-types.cjs` roda na imagem da API após a publicação. Sem `--apply`, consulta no máximo 20 registros ativos futuros e informa apenas UUID, tipo, motivo de retenção e necessidade de revisar recuperação; não imprime dados do paciente. A Vissmed é consultada por ID sem consumir o feed incremental.

```sh
node apps/api/scripts/backfill-legacy-appointment-types.cjs --limit=20
node apps/api/scripts/backfill-legacy-appointment-types.cjs --after=ULTIMO_UUID --limit=20
```

Para aplicar, revisar o resultado e fornecer explicitamente até 20 IDs. A rotina repete a validação antes de cada escrita. Exige registro anterior ao filtro, payload local ainda sem tipo, resposta única da Vissmed, ID, profissional e início idênticos, tipo `Consulta`/`Exame`/`Procedimento` e, para consulta, flag `mostrarnadoctoralia` reconhecida. Se a origem disser que um registro local ativo está cancelado, ou houver timeout, divergência ou resposta inválida, não classifica. Também não altera uma linha que mudou desde a leitura.

```sh
node apps/api/scripts/backfill-legacy-appointment-types.cjs --apply --ids=UUID_1,UUID_2
```

A escrita preserva os campos anteriores de `rawPayload` e acrescenta somente `tipo_servico` e a flag atual quando disponível. Não muda status, horários, vínculo de profissional, agendamento Vissmed, booking, bloqueio ou vaga Doctoralia. Um `AuditLog` por registro guarda tipo/flag anterior, tipo confirmado e sinal de que uma consulta habilitada sem vínculo Doctoralia precisa de análise para reentrega pelo fluxo normal. Esse sinal **não** solicita reentrega automaticamente. Consultas de profissional desabilitado (`mostrarnadoctoralia=0`) ficam classificadas no histórico, mas continuam vedadas à sincronização. Exames e procedimentos seguem fora do fluxo operacional e podem ser considerados pelo saneamento separado de bloqueios históricos, sempre com suas próprias proteções.

O lote padrão trata só os 353 futuros ativos porque são os que podem afetar a operação. Registros com horário passado ficam preservados; `--include-past` permite auditoria e aplicação explícita em lotes para necessidades históricas, sem fazer 21 mil chamadas automaticamente. Antes de uma aplicação em produção, registrar o conjunto de IDs e ter snapshot do banco. Para desfazer uma classificação específica, usar o `AuditLog` `legacy-type:<UUID>` para restaurar apenas os campos acrescentados, após confirmar que `rawPayload` não mudou novamente; não fazer rollback cego em lote.

## Validação e pendências operacionais

`node --test apps/api/scripts/legacy-appointment-type-policy.test.cjs` cobre classificação, preservação do payload, falhas de identidade/horário, cancelamento e flag desconhecida. O código deve ser executado somente após a publicação conjunta dos ajustes. Nenhum backfill ou pedido de reentrega foi realizado nesta auditoria. Após aplicar um lote, comparar contagens por tipo e revisar individualmente as consultas habilitadas sem break/booking para recuperação pelo feed normal, sem criar bloqueio diretamente a partir do script.
