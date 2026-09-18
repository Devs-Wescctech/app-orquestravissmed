# Habilitação de profissionais antes de publicar disponibilidade

> Atualização de 18/09: a proteção foi corrigida **suspendendo a limpeza automática insegura**, não implementando remoção seletiva. Consulte [correção e limitações atuais](professional-eligibility-fix-2026-09-18.md). As descrições de limpeza automática abaixo são históricas e foram substituídas por preservação com pendência.

Data: 18/09/2026. Branch: `codex/professional-eligibility`.
Base main: `943b93b070c65dac19a7beac67dac869957f6bd1`.
Escopo local; sem push, deploy, migração ou chamadas mutantes aos provedores.
Não inclui o candidato separado de automação de recusas.

## Regra e fonte

A VissMed informou que `scheduleDay` não filtra `mostrarnadoctoralia`.
Disponibilidade, vínculo local e nome não são autorização de publicação.
Consultar a lista atual de profissionais da clínica antes de publicar/ativar.

- GET `/api-docctor-3/api/v1.0/profissionais-by-idempresagestora?idempresagestora=52`.
- Usa conexão VissMed da clínica (empresa gestora e domínio); não o cadastro de outra unidade.
- Exige HTTP 200 e resposta JSON original em array. Sem converter falha/null em lista vazia.
- No contrato informado para `app.vissmed.com.br/api-docctor-3`, a lista filtra profissionais habilitados: presença válida habilita, ausência em lista válida exclui.
- Flags explícitas inativas excluem. Dados malformados, duplicados, IDs conflitantes, flags inválidas, conexão inválida ou falha de rede produzem estado desconhecido.
- Outras instâncias precisam de flag explícita positiva; ausência não autoriza limpeza.
- Não usa cache positivo antigo. Resposta paginada/envelope não é suportada e resulta em desconhecido; a interpretação de ausência depende da lista completa contratada.

## Comportamento

Sincronização global e de slots verificam elegibilidade antes de publicar. A global não provisiona o profissional excluído/desconhecido. Também verifica antes de ativar calendário e antes do PUT de horários. Horários vazios não são removidos se a habilitação deixar de ser confirmada durante o ciclo.

Exclusão confirmada tenta retirar apenas intervalos futuros com `managedState` válido, hash e escopo exatos de clínica/facility/profissional/endereço. Preserva passado e recorta intervalo em andamento a partir de agora (UTC-3, política atual). Exige vínculo atual exclusivo e nova confirmação antes do PUT. Inclui intervalos futuros registrados além da janela padrão de 30 dias.

Não chama cancelamento de reserva, exclusão de calendar break ou DELETE amplo de slots. Preserva vínculos compartilhados, estado legado sem evidência e casos incertos. Erro HTTP/persistência mantém evidência para nova tentativa no ciclo seguinte. Registra eventos `professional_eligibility_unknown`, `professional_eligibility_changed`, `professional_excluded`, `professional_cleanup_pending` ou `managed_scope_pending` quando há syncRun.

Não altera intervalos de execução do scheduler. As consultas adicionais de elegibilidade podem aumentar a duração de cada ciclo; latência sob carga ainda não medida.

## Contratos HTTP alterados

Autenticação JWT e validação de acesso à clínica existentes são preservadas. Não há novas rotas, parâmetros, paginação ou webhooks.

| Rota | Entrada existente | Mudança |
| --- | --- | --- |
| PUT `/appointments/slots` | `{clinicId, doctorId, slots}` | Exige vínculo LINKED e elegibilidade atual; caso contrário HTTP 400, sem PUT externo. |
| POST `/appointments/calendar-status` | `{clinicId?, doctoraliaDoctorId, status: "enabled" ou "disabled"}` | Para enabled, exige elegibilidade; HTTP 400 se não confirmada. Desativação permanece disponível. |
| POST `/sync/:clinicId/calendar/:doctoraliaDoctorId/enable` | Parâmetros de caminho | Exige vínculo LINKED e elegibilidade antes de acessar Doctoralia; HTTP 400 se não confirmada. |

Exemplo de erro de ativação: `{ "statusCode": 400, "message": "Habilitação do profissional na VissMed não confirmada. Agenda não ativada.", "error": "Bad Request" }`.
Respostas de sucesso e erros de autenticação/autorização anteriores não mudam. GET VissMed não tem novo corpo/credencial nesta alteração; utiliza transporte existente.

## Evidência TDD e verificação

Skill tdd-workflow aplicada: testes de regressão antes das correções, checkpoints RED/GREEN e cobertura dos módulos novos.

- `307ed5b`: RED inicial (quatro falhas de comportamento e módulo ainda inexistente).
- `23f18a3`: GREEN inicial, 30 testes.
- `956500f`: RED sincronização global/mudança de elegibilidade durante ciclo, três falhas.
- `d00cac1`: GREEN, 36 testes.
- `e022c0e`: RED ativação manual, quatro falhas reproduzidas; testes de limpeza incluídos.
- `0e2a91a`: GREEN ativação manual, seis testes.
- `a0a324e`: RED perda de elegibilidade antes da limpeza, uma falha reproduzida.
- Verificação final focada: 7 suítes, 52 testes passando. Módulos `professional-eligibility.ts` e `disabled-professional-slots.ts`: 97,33% statements, 93,97% branches, 100% funções e linhas.
- Regressão API: 79 suítes e 1.386 testes passando; 4 suítes/18 testes opt-in ignorados. Duas suítes dependentes de banco explicitamente excluídas: `queue.service.dedup-lease.spec.ts` e `queue.vismed-timeout.spec.ts`.
- `npm run build:api`: sucesso.
- `git diff --check`: sucesso.

Comandos executados:

```powershell
node node_modules/jest/bin/jest.js --config apps/api/package.json --runInBand --testPathPatterns 'professional-eligibility.spec|calendar-eligibility.spec|disabled-professional-slots.spec|slot-sync.managed-cleanup.spec' --coverage --collectCoverageFrom='integrations/vismed/professional-eligibility.ts' --collectCoverageFrom='sync/disabled-professional-slots.ts'
node node_modules/jest/bin/jest.js --config apps/api/package.json --runInBand --testPathIgnorePatterns 'queue.service.dedup-lease.spec.ts|queue.vismed-timeout.spec.ts'
npm run build:api
```

Instalação isolada via npm ci offline/ignore-scripts, Prisma Client gerado. Dependência nativa de teste extraída de pacote em cache. Nenhum manifest/lockfile alterado; nenhum .env de produção copiado.

## Atualização posterior

O fluxo de limpeza e suas verificações posteriores estão em [Remoção gerenciada com preservação](managed-slot-replacement-2026-09-18.md). As limitações e números abaixo retratam a etapa inicial, não a validação mais recente.

## Limitações e publicação

- Não executados E2E com provedores, UI/browser ou suítes que exigem banco dedicado. Testes usam doubles; não comprovam comportamento real do PUT de limpeza na Doctoralia.
- Antes de publicar: revisar pacote e domínio configurado, validar contrato com ambiente de teste e confirmar que PUT com serviços vazios preserva reservas/bloqueios. Reconciliar main se tiver avançado.
- Há janela inevitável entre leitura da flag e escrita remota; não existe transação distribuída. Sem snapshot remoto, alterações manuais dentro de intervalos anteriormente registrados como gerenciados não são detectadas por esta política de ownership.
- Não houve limpeza real nem modificação de profissionais. Publicação requer autorização; API precisa ser redeployada para aplicar o código. Não exige reiniciar banco/Redis.
- Rollback do código não recompõe automaticamente disponibilidade já retirada após eventual publicação; ressincronizar somente profissionais confirmados como habilitados.
