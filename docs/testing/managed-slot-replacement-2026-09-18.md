# Remoção gerenciada com preservação — 18/09/2026

Atualização posterior aos relatórios de suspensão da limpeza automática nesta branch. Implementação local, sem push ou deploy. Não altera o candidato separado de automação de recusas.

## Problema e correção

Em homologação, enviar apenas 08:10–08:40 com serviços vazios também retirava o controle 09:10–09:40. Portanto, a integração não pode tratar esse PUT como exclusão isolada comprovada. A estratégia validada envia o alvo vazio junto da configuração completa dos períodos conhecidos que devem permanecer na mesma data.

`managed-period-replacement.ts` planeja uma data por vez; `managed-slot-reconciler.ts` valida leituras remotas e confirma o resultado; `disabled-professional-slots.ts` integra autorização e persistência; `slot-sync.service.ts` usa o fluxo para profissionais excluídos e disponibilidade de origem vazia. Na origem vazia, a consulta de estados fica restrita ao endereço atual.

O registro JSON de disponibilidade passa a guardar os períodos completos publicados, incluindo duração e configuração de convênios, e um `periodsHash` normalizado. O hash anterior de publicação continua existindo. A normalização evita que a reordenação de propriedades pelo PostgreSQL JSONB invalide o registro. Nenhuma migration é necessária; dados existentes são preservados.

## Condições para remoção automática

- Vínculo atual exclusivo da clínica/médico e elegibilidade reconfirmada antes do PUT.
- Registro completo, hash e escopo compatíveis; alvo conhecido e ainda não iniciado.
- Todos os slots e serviços remotos da data correspondem ao registro local, em duas leituras.
- Nenhuma reserva ou calendar break na data; respostas completas, sem paginação pendente.
- PUT inclui os períodos preservados completos; GET posterior confirma alvos ausentes e demais períodos presentes.
- Atualização local somente após confirmação remota, com compare-and-set do hash anterior.

Estados antigos somente com início/fim não permitem reconstruir duração e convênios e continuam pendentes. Não se inferem configurações a partir do catálogo ou dos horários retornados pelo GET. Dias ocupados, vínculos compartilhados, horários desconhecidos, períodos passados/em andamento e resultados incertos ficam preservados. Não há cancelamento de consulta, remoção de calendar break nem DELETE de data.

## Contrato externo

Sem novas rotas públicas ou alterações de autenticação. Usa o transporte Doctoralia já existente:

- GET `/api/v3/integration/facilities/{facility}/doctors/{doctor}/addresses/{address}/slots?start={inicio}&end={fim}&with[]=slot.services`: leitura expandida para confronto de horários e IDs de serviços. Não retorna duração/configuração original suficiente para reconstrução.
- GET de `bookings` e `calendar-breaks`, via métodos existentes, para barrar dias ocupados.
- PUT no mesmo recurso `/slots`, corpo `{ slots: [...] }`: alvo com `address_services: []`, demais períodos com a configuração original completa. HTTP de sucesso sozinho não conclui a limpeza: exige leitura posterior compatível.

Erros, timeout, leitura incompleta, divergência ou falha de persistência retornam pendência e mantêm a evidência anterior. A rotina não envia uma segunda reconstrução improvisada. Eventos existentes `professional_cleanup_pending` / `managed_scope_pending` registram a situação quando há syncRun. Scheduler sem alteração; leituras adicionais aumentam o custo/duração do ciclo, não medidos sob carga.

Referência consultada: https://integrations.docplanner.com/docs/ (OpenAPI incorporado, ReplaceSlotsRequest). Comportamento de substituição observado apenas no cenário de mesma data; não generalizar para outras datas sem teste.

## Verificações executadas

- TDD: 4932702 RED planejador; 97ca0a5 GREEN; ad8dfa6 RED registro completo/reconciliador; 1126cfa GREEN; f2703c4 RED integração; 7534ae0 RED isolamento por endereço; f1ada56 RED persistência JSONB. As falhas foram reproduzidas antes das respectivas correções.
- 52 testes focados passaram. Cobertura dos dois módulos novos: 90,44% statements, 86,25% branches, 94,11% funções, 94,87% linhas.
- Regressão API com PostgreSQL descartável: 86 suítes/1.455 testes passaram; 2 suítes/5 testes opt-in executados separadamente nas bases consultation_test e refusal_test, todos passaram. Total distinto: 1.460 testes.
- Novo teste PostgreSQL confirma persistência, isolamento de outro endereço e ausência de repetição de PUT após conclusão.
- Build API e TypeScript sem emissão passaram. ESLint passou nos quatro módulos de registro/planejamento/reconciliação/limpeza. Não se afirma lint integral do repositório.
- Teste real autorizado: facility 140548, doctor 1396868, address 1750984, serviço 6018375; data sintética 22/09/2026. Reconciliador compilado retirou 08:10–08:40 e preservou 09:10–09:40; resposta PUT 201 e leitura posterior confirmada. Limpeza final restaurou a agenda de teste vazia.
- Script reproduzível: `node scripts/probe-slot-replacement.cjs --authorized-sandbox`, após build, somente com nova autorização de uso da homologação. Guarda rígida de host/endereço/intervalos/serviço; nenhuma credencial impressa ou armazenada no relatório.

## Limites e publicação

Não há transação/ETag distribuído: outra integração ou edição manual pode ocorrer entre leitura e PUT. Dupla leitura reduz, mas não elimina essa janela. Alteração apenas de convênios, mantendo os mesmos slots/serviços, não é detectável por esse GET. Isso impede uma garantia absoluta contra alterações concorrentes externas.

Não executados E2E de navegador nem notificações/cancelamentos de pacientes reais. Não houve alteração de produção. Publicar exige revisão/aprovação do candidato e redeploy da API; não reiniciar banco/Redis. Rollback de código não repõe automaticamente slots já retirados. Registros legados permanecem pendentes até existir evidência completa; não promover dados desconhecidos a gerenciados.
