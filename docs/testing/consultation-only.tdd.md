# Evidências — filtro somente consultas

17/09/2026. Worktree appointment-types, branch codex/appointment-types. Base remota conferida: 37222186b7fd41f59278cb4918e4129c7ae53ae4. Sem push, deploy, backfill ou alteração de agendamentos reais.

## TDD e verificações

- 258d2d7: RED inicial (10 falhas, 2 aprovados); daab9e4: GREEN (12 aprovados).
- a3a0c04: RED leitura direta/slots (2 falhas, 41 aprovados).
- 441b62d: RED verificação pós-criação (3 falhas, 43 aprovados).
- Rodada final API: 1.386 aprovados, zero reprovados, quatro ignorados, 79 suites consideradas pelo Jest.
- Política isolada: 53 testes aprovados; consultation-policy.ts com 96,66% statements, 83,33% branches, 100% funções e 100% linhas. Não representa cobertura de todo o sistema.
- Frontend: 24 testes Node aprovados. Os dois novos são contratos estáticos dos filtros das duas fontes e da projeção de tipo, não E2E visual.
- Build API, build web e TypeScript web sem emissão: saída zero. Web gerou 19 páginas. Next avisou falha ao tentar corrigir dependências SWC do lockfile; lockfile não alterado. Build Next tem lint/tipos desabilitados na configuração; TypeScript foi executado separadamente. Não executado lint com autofix.
- git diff --check sem erros de whitespace.

Cobertura funcional: consulta elegível; exame/procedimento/desconhecido; profissional desabilitado; catálogo não brasileiro; ID de endereço diferente do dicionário; serviços mistos; autoridade VissMed; reclassificação; cache por lote (1.000 registros); criação/cancelamento/remarcação/bloqueio/retries; leitura remota sem reintroduzir exame; slots sem serviço elegível; desaparecimento sem confirmação; resposta com ID divergente; pós-criação com tipo incorreto; registros/estatísticas e isolamento por clínica.

Fixtures antigas foram atualizadas para declarar consultas e serviços verificados. A política não foi globalmente simulada para fazer a suíte passar.

## Banco real isolado

PostgreSQL 16-alpine no Docker Desktop local: container codex-consultation-tests-20260917, porta 127.0.0.1:60332, banco consultation_test, dados em tmpfs, sem volumes do usuário. Schema gerado do Prisma atual, sem modificar o schema do projeto. Índice parcial de deduplicação aplicado somente no banco de teste para reproduzir a invariante da fila.

Suíte HTTP nova: quatro testes aprovados com Prisma/PostgreSQL e controlador/serviço reais, autenticação simulada e lifecycle de jobs desabilitado. Verifica 401/403/isolamento, resultados e preservação de status/bloqueio compartilhado sintético na reclassificação. Testes de claim/fila também usam banco isolado. Nenhuma credencial de produção usada nos testes.

Comando base: node node_modules/jest/bin/jest.js --config apps/api/package.json --runInBand. Para reproduzir, configurar DATABASE_URL descartável e BOOKING_CLAIM_PG_TESTS=true, CONSULTATION_PG_TESTS=1. Teste novo exige loopback e banco consultation_test. REFUSAL_DB_TEST=0 e SYNC_TEST_DATABASE=false desativam os ambientes exclusivos abaixo.

## Limitações

- Quatro testes preexistentes ignorados: refusal-cancellation.postgres exige orq-refusal-test-db/refusal_test; sync-pipeline.postgres exige 127.0.0.1:55439/sync_test. Esses ambientes não foram criados nem suas proteções enfraquecidas.
- Sem E2E autenticado de navegador, criação/cancelamento real externo, validação pós-deploy ou medição de tempo entre os três sistemas.
- Catálogo Doctoralia lido por HTTP 200; lista de consultas deriva de revisão dos nomes. Serviços novos/ambíguos exigem classificação futura.
- Histórico desconhecido fica excluído até receber classificação. Bloqueios históricos, inclusive compartilhados, não foram removidos. O saneamento do incidente original exige etapa própria.

Entrega local validada, não garantia de ausência de todo erro possível. Publicação depende da revisão dos controles e do ambiente em execução.
