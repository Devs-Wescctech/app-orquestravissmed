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