# Gate pré-deploy — contrato do feed de agendamentos VisMed

> **Estado atual: BLOQUEADO.** Não existe neste repositório evidência formal ou não destrutiva suficiente para classificar as bases VisMed efetivamente consumidas pelo ambiente Portainer.
>
> Este gate deve ser concluído **antes de qualquer deploy** que contenha o modo de feed. Ele não autoriza ativar `INCREMENTAL`, editar conexões, pausar fluxos ou alterar dados.

## Regra de decisão

Somente é permitido prosseguir com o deploy se **todas** as instâncias/bases VisMed usadas por conexões ativas estiverem classificadas como `LEGACY` mediante evidência positiva.

Uma classificação `INCREMENTAL`, `MISTA` ou `INCONCLUSIVA` bloqueia o deploy. Registrar o bloqueio, preservar a evidência e encaminhar a decisão para a Fase 2; não usar o campo local nullable como evidência de que o upstream é snapshot.

É proibido chamar exploratoriamente `get-agendamento-filtros` em produção para obter esta prova: sob o novo contrato, a própria leitura pode marcar uma pendência como entregue.

## Evidência aceita

Registre uma das seguintes fontes, sem credenciais ou dados de pacientes:

1. confirmação técnica formal da VisMed, específica para a base e a rota;
2. demonstração em homologação que seja comprovadamente não destrutiva;
3. dados de teste controlados que mostrem a semântica de retorno sem consumir registros produtivos.

Para cada base, a evidência deve responder se a ausência de um ID no retorno significa:

- `LEGACY`: o ID não existe mais na janela (snapshot); ou
- `INCREMENTAL`: o ID pode apenas já ter sido entregue/sincronizado.

## Inventário e classificação obrigatórios

Preencher uma linha para **cada base/instância distinta** consumida pelas conexões VisMed ativas no Portainer. Use identificadores técnicos não sensíveis (por exemplo, hostname/base mascarada); não registrar `clientId`, URL assinada, credenciais ou informações de pacientes.

| Instância/base técnica | Conexões/clínicas cobertas | Fonte da evidência | Data (UTC) | Escopo testado | Classificação | Responsável | Decisão |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **PENDENTE — inventariar no Portainer** | — | — | — | — | `INCONCLUSIVA` | — | **BLOQUEAR DEPLOY** |

## Checklist de liberação

- [ ] Inventário obtido a partir das conexões VisMed ativas no **Portainer**, não da base de deployment do Replit.
- [ ] Toda base no inventário tem evidência aceita, com fonte, data e escopo técnico registrados.
- [ ] Toda linha está classificada explicitamente como `LEGACY`.
- [ ] Não há base `INCREMENTAL`, `MISTA` ou `INCONCLUSIVA`.
- [ ] Não houve chamada exploratória produtiva a `get-agendamento-filtros`.
- [ ] Confirmado que o deploy/migration não define `vismedAppointmentFeedMode` em nenhuma conexão.
- [ ] Busca pós-migration confirma zero conexões com `vismedAppointmentFeedMode = 'INCREMENTAL'`.

Se qualquer item falhar, o deploy permanece bloqueado e a Fase 2 deve decidir o contrato completo (incluindo preflight, verificação pós-criação, cancelamentos e reentrega).

## Proteções já confirmadas no código

- O caminho `LEGACY` mantém a leitura snapshot, preflight por profissional/data/horário/paciente, verificação pós-criação e reconciliação por desaparecimento.
- No modo explícito `INCREMENTAL`, apenas o polling pode chamar `get-agendamento-filtros`. Um retorno vazio nesse feed não comprova cancelamento, inexistência nem criação fantasma.
- O preflight incremental está **BLOQUEADO POR CONTRATO VISSMED**: antes do POST não há necessariamente `idpacienteagendamento`, e não existe busca não destrutiva adequada para localizar um possível agendamento.
- A verificação incremental pós-POST está **BLOQUEADA POR CONTRATO VISSMED** até que a VisMed informe endpoint, método, request e response oficiais para consultar um `idpacienteagendamento` sem consumir o feed. Até lá, ela retorna somente `unverified`, nunca `not_found`.
- Falhas de processamento com ID identificável são registradas de forma deduplicada como candidatas à futura reentrega. Não há chamada de recovery, ACK local, persistência adicional, fila externa ou pipeline paralelo.

## Contratos que a VisMed ainda deve fornecer

Nenhum dos itens abaixo pode ser inferido por tentativa em produção:

1. **Busca pré-POST não destrutiva:** forma oficial de localizar um possível agendamento por profissional, data, horário e paciente sem consumir pendências. A consulta por ID não a substitui.
2. **Verificação pós-POST por ID:** endpoint, método HTTP, autenticação, request, response, semântica de ausência e garantias de não consumo para `idpacienteagendamento`.
3. **Recovery em lote:** endpoint, método, payload/resposta, limites de lote, erros parciais e confirmação de que os IDs retornam ao mesmo feed após `ultimasincronizacaodoctoralia` ser redefinida.
4. **Cancelamentos incrementais:** fonte contratual para distinguir item já entregue de item removido/cancelado. A reconciliação por desaparecimento permanece deliberadamente suprimida nesse modo.

## Condições adicionais para ativação futura

- [ ] Os quatro contratos acima foram recebidos por escrito e implementados com testes de integração em homologação não destrutiva.
- [ ] O preflight incremental pode obter uma conclusão segura sem depender de `get-agendamento-filtros`.
- [ ] A verificação pós-POST por ID confirma presença/ausência sem consumir outro item do feed.
- [ ] Recovery valida IDs, envia somente lotes autorizados pelo contrato e aguarda a reentrega pelo polling; o processamento continua no mesmo upsert idempotente por `clinicId + vismedAppointmentId`.
- [ ] A estratégia de cancelamento incremental foi aprovada sem alterar os fluxos legados de breaks e propagação à Doctoralia.
- [ ] Uma nova revisão operacional aprovou explicitamente cada base antes de qualquer conexão ser marcada como `INCREMENTAL`.