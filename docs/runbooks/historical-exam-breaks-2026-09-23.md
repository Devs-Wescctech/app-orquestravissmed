# Bloqueios históricos de exames e procedimentos

## Diagnóstico em 23/09/2026

A stack `orquestrador_vissmed` foi consultada pelo console do contêiner `vismed`, apenas com leituras Prisma e GETs individuais. Nenhuma chamada DELETE nem atualização de banco foi executada nesta avaliação.

- 339 vínculos futuros com `doctoraliaBreakId` foram encontrados. Oito registros anteriores a 18/09 têm `tipo_servico` armazenado como Exame (1) ou Procedimento (7).
- Os oito foram confirmados por `get-agendamento-by-id` da Vissmed: ID e tipo continuam correspondendo ao registro local.
- Sete possuem comprovante `CALENDAR_BREAK_CREATION` em estado `OWNED` com escopo e ID correspondentes. Seus bloqueios foram confirmados por GET na Doctoralia (HTTP 200, ID e horários iguais).
- Cinco desses sete não têm outro agendamento ativo local sobreposto nem associação compartilhada ao ID do bloqueio. São candidatos ao saneamento.
- Dois dos sete coincidem com registros antigos cujo `tipo_servico` local é desconhecido. Mantê-los até classificar esses registros e verificar a agenda remota; ausência de classificação não é prova de inelegibilidade.
- O oitavo não possui comprovante de criação e coincide com uma Consulta. Manter o bloqueio; uma simples associação local por ID ou horário não prova propriedade exclusiva.

Os números são um instantâneo, não uma lista permanente de exclusão. Não usar o inventário de 18/09 como autorização para apagar um bloqueio em data posterior.

## Tratamento preparado

O utilitário `apps/api/scripts/cleanup-historical-exam-breaks.cjs` é incluído na imagem da API. No contêiner, sua execução sem parâmetros apenas informa a elegibilidade atual de cada registro anterior a 18/09:

```sh
node apps/api/scripts/cleanup-historical-exam-breaks.cjs
```

Ele preserva todos os registros com tipo desconhecido, horário passado, associação compartilhada, sobreposição ativa, comprovante ausente/inconsistente, mudança de tipo na Vissmed, credencial Doctoralia expirada, erro de rede ou divergência de ID/horário remoto. A data de corte é conservadora: registros criados no próprio dia 18/09 exigem análise separada porque a hora exata da publicação não foi usada como evidência.

Quando a publicação conjunta dos ajustes for autorizada e os cinco candidatos forem novamente revisados, o modo de aplicação exige uma lista explícita de IDs `BookingSync` copiada do dry-run:

```sh
node apps/api/scripts/cleanup-historical-exam-breaks.cjs --apply --ids=UUID_1,UUID_2
```

Antes de qualquer DELETE, o utilitário repete a verificação local, consulta individual na Vissmed e GET exato na Doctoralia. Se algum ID solicitado perder elegibilidade, a operação inteira é abortada antes das remoções. Para cada remoção bem-sucedida, ele limpa apenas `doctoraliaBreakId` da linha histórica, marca `syncedToDoctoralia=false` e registra `state=REMOVED`, data e motivo no comprovante. Não cancela o agendamento na Vissmed, não apaga `BookingSync`, não altera consultas ou slots. O tratamento externo não é transacional: se o DELETE remoto ocorrer e a atualização local falhar, interromper o lote e reconciliar esse item manualmente; nunca forçar um segundo DELETE sem novo GET e inspeção.

A consulta SQL complementar em `docs/runbooks/sql/audit-historical-exam-breaks.sql` executa uma transação somente leitura. Ela inclui sobreposições entre *todos* os `BookingSync` ativos no mesmo médico/endereço, não só os que têm bloqueio. Não substitui as verificações individuais de origem e destino.

## Validação e estado

`node --test apps/api/scripts/historical-break-cleanup-policy.test.cjs` cobre elegibilidade positiva, preservação de casos ambíguos, tipo atual da Vissmed e ID/horário remoto. O script passou em `node --check` e `git diff --check`. O modo `--apply` não foi executado; nenhum bloqueio de produção foi removido nesta etapa. A verificação remota final e o tratamento ficam para a publicação conjunta solicitada pelo usuário.
