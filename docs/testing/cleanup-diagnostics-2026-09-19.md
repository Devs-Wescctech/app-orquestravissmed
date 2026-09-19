# Diagnóstico das limpezas pendentes — 19/09/2026

## Escopo

Pedido: melhorar os casos de limpeza após o ciclo de Petrópolis das 20:39 apresentar 17 mensagens genéricas. A evidência de produção não permite atribuir a todos a mesma causa. Esta alteração não afirma que os 17 casos foram resolvidos.

Branch `codex/cleanup-diagnostics`, base main remota conferida `e43ca95981511f7e8c13e41c514f11aae68dfd1e`. A branch anterior e seu relatório posterior foram preservados. Manifests e lockfile idênticos à base; ambiente de dependências continua o isolamento do candidato anterior, sem atualização ou reaproveitamento de dependências de outra versão do lockfile. Obsidian MCP indisponível e Graphify não instalado; consultados arquivos específicos do fluxo.

## Comportamentos

- Eventos identificam profissional, IDs VISSMED/Doctoralia, clínica, endereço e data quando conhecida.
- Motivos separados: histórico legado sem serviços/durações; registro inválido/escopo incorreto/hash divergente; vínculo ausente/compartilhado; elegibilidade alterada; mudança concorrente; reserva; bloqueio; leitura incompleta/falha; divergência remota; falha/timeout do envio; leitura posterior inconclusiva; falha em persistir resultado remoto confirmado.
- Estado de escrita explícito: `not_sent`, `unknown` ou `confirmed`. Erros brutos e payloads externos não entram no diagnóstico.
- Histórico legado válido, do escopo correto e somente passado deixa de gerar aviso de limpeza futura. Nenhuma linha histórica é apagada/alterada por essa dispensa; histórico malformado ou duvidoso permanece pendente.
- Fluxo automático de remoção mantém conferências, proteção de reservas/bloqueios, leitura dupla, verificação posterior e persistência condicional. Não reconstruir serviços/durações desconhecidos.

## Contrato e compatibilidade

Sem endpoint ou schema novo. `GET /sync/:clinicId/history` conserva autenticação/permissões, estrutura dos eventos e actions `professional_cleanup_pending`/`managed_scope_pending`; somente `message` fica detalhado. Exemplo sintético: `Profissional Teste (VISSMED 123; Doctoralia 456; clínica c): ... Endereço a, data 2030-01-02: [bookings_present] Há reservas nesta data... Nenhuma remoção enviada.`

`reconcileManagedRemoval` mantém retorno booleano e ganha callback opcional com diagnóstico. `DisabledProfessionalSlots.reconcile` acrescenta `issues` ao resultado interno. Interface existente já exibe mensagens de eventos; não houve mudança de frontend.

## Evidência TDD

- RED `68ce5cf`: 11 falhas esperadas e 37 testes aprovados (diagnóstico ausente, identidade ausente e falso aviso de histórico passado).
- GREEN `7f42ef9`: mesmo comando, 48 testes aprovados.
- Ampliação: 70 testes em quatro suites aprovados. Cobertura dos três módulos de diagnóstico/reconciliação: 95% statements, 93,47% branches, 95,23% funções, 96,94% linhas.
- Regressão relacionada: 154 testes em 9 suites aprovados.
- Painel: 20 testes Node/React aprovados. Não são E2E de navegador.
- TypeScript sem emissão e compilação da API com `tsc` aprovados. `git diff --check` sem erro.

Comandos efetivamente usados:

```text
npm test --workspace apps/api -- --runInBand --silent --testPathPatterns='managed-slot-reconciler.spec|disabled-professional-slots.spec|slot-sync.managed-cleanup.spec'
npm test --workspace apps/api -- --runInBand --silent --testPathPatterns='managed-slot-reconciler.spec|disabled-professional-slots.spec|cleanup-diagnostics.spec|slot-sync.managed-cleanup.spec' --coverage --collectCoverageFrom='sync/managed-slot-reconciler.ts' --collectCoverageFrom='sync/disabled-professional-slots.ts' --collectCoverageFrom='sync/cleanup-diagnostics.ts'
npm test --workspace apps/api -- --runInBand --silent --testPathPatterns='slot-sync|managed-slot|managed-period|disabled-professional|cleanup-diagnostics|sync-observation'
npx tsc --noEmit -p apps/api/tsconfig.json
npx tsc -p apps/api/tsconfig.json
node --test apps/web/tests/sync-execution-summary.test.cjs apps/web/tests/sync-run-report.test.cjs
```

Sem teste com PostgreSQL real, novo E2E ou escrita em Doctoralia nesta etapa: dependências externas simuladas, escopo de diagnóstico e critérios seguros testados. Nenhum push/deploy deste pacote realizado. Após publicação autorizada, novos ciclos produzirão as causas específicas; mensagens históricas não são reescritas. Não prometer redução a zero das pendências nem remoção automática dos 17 casos.
