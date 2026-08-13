# Harness de carga do módulo de sincronização (WP-12A/12B)

Pista de testes de carga local para o orquestrador Doctoralia↔VisMed. **Nenhuma linha
de código produtivo é alterada**: mocks HTTPS locais, Postgres de teste efêmero,
dataset sintético determinístico, runner com coleta de métricas e relatório
versionável com pass/fail automático.

## Como rodar

```bash
cd apps/api
npm run load:test -- --scenario=a --profile=medium          # Cenário A (baseline)
npm run load:test -- --scenario=a --profile=medium --seed=x # seed customizada
npm run load:test -- --scenario=a --profile=medium --skip-build # reusa dist/ existente
npm run load:test:spec                                      # testes do próprio harness
npm run load:test -- --scenario=b --profile=medium          # WP-12B: 10 clínicas
npm run load:test -- --scenario=c --profile=medium          # WP-12B: 20 clínicas
npm run load:test -- --scenario=d --profile=medium          # WP-12B: 50 clínicas
npm run load:scale                                          # WP-12B: B→C→D com regra de parada + sumário
```

Saída: `load-test/reports/scenario-<cenário>-<perfil>-<timestamp>.{json,md}`.
Exit code: `0` = todos os critérios passaram, `2` = algum critério falhou, `1` = erro do harness.

## Arquitetura

1. **Mock Doctoralia** (`lib/mock-doctoralia.js`) — HTTPS em `127.0.0.1:45443` com
   certificado exclusivamente de teste. Cobre OAuth, facilities/doctors/addresses/
   services/insurance, slots (GET/PUT), bookings (list/detail/create), breaks,
   notifications e calendar. Registra cada GET/WRITE com timestamp.
2. **Stub VisMed** (`lib/mock-vismed.js`) — HTTPS em `127.0.0.1:45444`. Stateful:
   agendamentos criados via `schedule/pacient` aparecem em `get-agendamento-filtros`
   (a verificação pós-criação do orquestrador exige isso). *Nota: o plano dizia que
   HTTP bastaria, mas o cliente VisMed usa o módulo `https` do Node em GETs — por
   isso o stub também roda em HTTPS com o mesmo cert de teste.*
3. **TLS** — abordagem (1) do plano: `NODE_EXTRA_CA_CERTS` apontando para o cert de
   teste, definido **apenas** no env do processo filho da API (verificado: o fetch/
   undici do Node 20 honra a variável). A validação TLS permanece ativa; nunca é
   usado `NODE_TLS_REJECT_UNAUTHORIZED=0`.
4. **Postgres de teste** (`lib/testdb.js`) — cluster novo via `initdb` em
   `load-test/.runtime/pg`, porta 55442, loopback apenas, banco `loadtest_db`
   (o nome DEVE conter `loadtest` — o guard exige). Schema aplicado com
   `prisma db push`; teardown = `pg_ctl stop` + remoção do diretório. Criação e
   destruição acontecem somente via runner.
5. **Dataset** (`lib/dataset.js`) — determinístico por seed (mulberry32). Perfis
   `small`/`medium`/`heavy` (médicos/clinica, endereços, serviços, bookings,
   agendamentos VisMed, slots/dia). O mesmo dataset alimenta seed do banco e mocks.
6. **Guards anti-produção** (`lib/guards.js`) — o runner recusa iniciar se:
   `DATABASE_URL` não for loopback + nome com `loadtest`; qualquer
   `IntegrationConnection` apontar para domínio real (doctoralia/docplanner/
   znanylekarz/vissmed) ou host não-loopback; `PROD_DATABASE_URL` estiver no env do
   processo sob teste. O env do filho é construído do zero (sem secrets do runner).
   Mocks escutam apenas em `127.0.0.1`.
7. **Runner** (`runner.js`) — seed → mocks → API filho (crons desligados via
   `DISABLE_SYNC_CRON`/`DISABLE_BOOKING_SWEEP`/`DISABLE_BLOCK_WATCHER`) → login
   SUPER_ADMIN → reset do baseline → Cenário A pelos gatilhos manuais existentes
   (`/sync/:id/global`, `/sync/:id/slots`, `/booking-sync/poll`,
   `/booking-sync/poll-vismed`, `/booking-sync/safety-sweep`) → coleta → relatório
   → teardown. Sem Redis local, o `queue.add` falha com ECONNREFUSED e o app usa o
   caminho direto documentado (fallback sem Redis) — comportamento produtivo real.
8. **Coleta** (`lib/collector.js` + `lib/preload-lag.js`) — snapshots de
   `GET /metrics/doctoralia-baseline` a cada 5s; RSS via `/proc`; heap + event-loop
   lag via sidecar `--require` (perf_hooks) injetado por `NODE_OPTIONS` no processo
   sob teste (sem tocar código produtivo); QPS/conexões/slow queries do Postgres de
   teste (`pg_stat_activity`, `pg_stat_database`, `pg_stat_statements` se disponível).

## Critérios pass/fail (automáticos)

- Budgets nunca excedidos, auditados nas chamadas **recebidas pelo mock**:
  agregado 400/5min, WRITE 40/min e 2.400/h (janela deslizante).
- Zero escrita duplicada nos mocks (mesmo método+path+corpo em <120s; repetições
  espaçadas — ex.: refresh legítimo entre janelas — não contam).
- Filas HIGH/LOW voltam a 0 ao final; oldest waiter ≤60s e `QueueTimeout=0`
  (deadline HIGH 15s é coberto pelos timeouts).
- Toda clínica completa o global sync (0 failed, 0 preso em `running`).
- Reservas de prioridade expiradas = 0.
- O relatório inclui comparação contadores do mock vs. baseline de métricas.

## O que cada métrica significa

- `budgets.peak*` — pico observado na janela deslizante correspondente no mock.
- `queues.waitMs` — espera na fila do rate limiter (p50/p95/p99/max) do baseline.
- `counterComparison.apiDelta` — mock − baseline; esperado ≈ 0 (pequenas diferenças
  = chamadas em trânsito no último snapshot).
- `process.eventLoopLagMs` — atraso do event loop do processo da API (sidecar).
- `postgres.maxQps` — transações/s aproximadas via deltas de `pg_stat_database`.

## Limitações conhecidas

- As métricas do baseline são **in-memory**: zeram em restart da API.
- Pollers de booking e o token refresher **não têm flag de desligamento** — os
  disparos automáticos coexistem com o cenário; como as conexões apontam para os
  mocks, são inofensivos e ficam contabilizados nos logs do mock e no baseline.
- `pg_stat_statements` pode não existir no build do Postgres; nesse caso slow
  queries não são coletadas e a limitação é registrada no relatório.
- Notificações Doctoralia retornam vazias no Cenário A (o fluxo de criação de
  bookings é exercitado pelo sweep e pelo poll VisMed).

## WP-12B — Testes de escala (10/20/50 clínicas)

- **Cenários**: `b`=10, `c`=20, `d`=50 clínicas — mesma estrutura do Cenário A
  (janelas de global sync + polling/sweep/slot), só a escala muda. 50 é marco de
  teste, não limite arquitetural.
- **Comparação com baseline A** (`lib/baseline-compare.js`): cada relatório de
  B/C/D inclui a comparação métrica-a-métrica com o JSON versionado do Cenário A
  mais recente (ou `--baseline=<path>`) e fatores de crescimento relativos
  (razões atual/baseline; sem thresholds absolutos de latência).
- **Novos checks pass/fail** (além dos do 12A):
  - memória RSS/heap estabiliza — falha só se a série for essencialmente
    monotônica (≥90% dos deltas não-negativos) E o último quartil crescer ≥10%
    sobre o anterior (warmup de 25% descartado; <8 amostras = inconclusivo);
  - `QueueFull`/`QueueTimeout` = 0 (no cenário D, ≠0 exige justificativa
    explícita registrada no relatório);
  - encerramento limpo: a API precisa sair com SIGTERM dentro do prazo — se
    precisar de SIGKILL há Promise/timer órfão segurando o processo.
- **Progressão B→C→D** (`run-scale.js` / `npm run load:scale`): executa em ordem,
  cada relatório é persistido pelo runner assim que o cenário termina; regra de
  parada — se um cenário falhar (exit ≠ 0), os seguintes NÃO executam; relatórios
  anteriores nunca são apagados; falha/interrupção gera relatório PARCIAL com o
  motivo; ao final grava `reports/scale-summary-*.{md,json}` (cenário mais alto
  saudável, primeiro gargalo, fatores de crescimento).
- **slot-sync em escala**: HTTP 409 é o concurrency guard funcionando; o runner
  tenta em round-robin (uma clínica ocupada não serializa as demais) até um
  deadline que escala com o nº de clínicas.
- Timeouts de espera de SyncRuns e drenagem final também escalam com o nº de
  clínicas.

## WP-13 — Fault injection e resiliência (F1–F5)

Injeção determinística de falhas **só no mock/harness** (código produtivo
`apps/api/src/**` intocado) para provar degradação controlada e auto-recuperação.

### Como rodar

```bash
# Bateria completa: Baseline (cenário b, controle saudável) → F1 → F2 → F3 → F4 → F5
npm run load:faults                      # seed padrão wp13
node load-test/run-faults.js --seed=wp13 --skip-build
node load-test/run-faults.js --only=f2   # um cenário isolado

# Ou direto pelo runner:
node load-test/runner.js --scenario=f1 --profile=medium --seed=wp13 --skip-build
```

Todos os cenários de falha usam **10 clínicas / medium / seed fixa** e seguem a
estrutura: janela saudável estrita (T0) → `arm()` do injector → bomba de carga
contínua durante a janela de falha → espera de recuperação (breaker CLOSED +
filas 0 + sem runs ativos) → **janela final de sync saudável** (obrigatória).
Durante fault injection o collector amostra a cada **1,5s** (timeline fina).

### Fault injector (`lib/fault-injector.js`)

Plano = lista de regras `{tag, method, pathRe, startMs, endMs, action, params,
modulo}` com janelas temporais **relativas ao `arm()`** e parâmetros derivados
da seed (determinístico). Primeira regra que casa vence. Ações: `http429` (com/
sem `Retry-After`), `http503`, `delay` (latência <30s), `timeout` (segura o
socket sem responder; destruído no `stop()`), `reset` (destrói a conexão),
`waf` (**contrato exato do classificador produtivo**: HTTP 405 + body casando
`/captcha|challenge|awswaf|human|verifica/i`) e `shortToken` (OAuth com
`expires_in` curto p/ forçar refresh). Cada injeção é registrada no CallLog com
a `faultTag` da regra.

### Planos (`lib/fault-plans.js`)

- **F1 — 429**: F1-A intermitente (~1/3 das reqs, 0–60s; WP-07 absorve, breaker
  fica CLOSED) + gap saudável + F1-B sustentado (90–210s; 5 operações lógicas
  exauridas → breaker abre, cooldown, HALF_OPEN, probe, CLOSED).
- **F2 — 503** sustentado (0–150s): OPEN → 1ª probe (~+60s) ainda na janela →
  FALHA → reabre com cooldown **dobrado** (120s) → 2ª probe fecha.
- **F3 — timeout >30s** (0–180s): AbortController aborta a 30s, retries e
  breaker reagem, sockets pendurados não sobrevivem, filas drenam depois.
- **F4 — WAF** em duas janelas no mesmo cenário: GET comum (0–20s) e OAuth
  (480–660s, com `shortToken` forçando refresh na janela). Abertura em **1**
  resposta, zero retry do request WAFado, cooldown ≥5min, recuperação por probe.
- **F5 — API lenta sem erro**: delay 11–13s (<30s, sem abort) por 120s — valida
  WP-08B: filas crescem, deadlines (HIGH 15s / LOW ~61s) geram QueueFull/
  QueueTimeout que **não** alimentam o breaker nem marcam a integração como
  error; backlog drena após a janela.

### Relatório e critérios (`lib/fault-report.js`)

Timeline obrigatória **T0→T6** (HEALTHY → falha → proteção reage → mock volta a
200 → recuperação detectada → filas drenadas → HEALTHY) com os deltas entre
etapas. Critérios PASS/FAIL automáticos: budgets nunca excedidos (400/5min,
40 WRITE/min, 2.400/h); zero writes duplicados; zero corrida de OAuth (<5s);
breaker abre **somente** quando deveria (F1-A e F5 exigem CLOSED); durante OPEN
zero arrivals no mock (fast-fail via CallLog, com graça p/ retries in-flight
admitidos antes do OPEN); HALF_OPEN com exatamente 1 probe; volta a CLOSED;
filas 0 ao final; nenhum SyncRun preso; toda clínica completa full+vismed-full
**pós-recuperação**; F2 exige razão ~2× entre durações OPEN; F4 exige abertura
imediata, zero retry WAFado e OPEN ≥5min; F5 exige QueueFull/Timeout > 0 com
breaker sempre CLOSED; nenhuma conexão pode terminar com status persistido
'error' no banco (QueueFull/QueueTimeout não podem desconectar a integração); memória estável; encerramento limpo; nenhum host real.

### Regra de parada

`run-faults.js` executa Baseline → F1 → … → F5 **um por vez**; no primeiro FAIL
estrutural a bateria **PARA**: o relatório do cenário é mantido, o consolidado
(`reports/wp13-consolidado-*.{md,json}`) registra a primeira limitação
estrutural e **nada é corrigido, repetido ou relaxado** para passar. Relatórios
individuais: `reports/scenario-f?-medium-*.{md,json}` + NDJSON de arrivals.

### Testes do injector

`tests/fault-injector.test.js`: janela aberta/fechada/desarmado, `modulo`
determinístico, cada ação de falha contra o MockDoctoralia real (HTTPS
loopback) e o corpo WAF exato validado contra o regex do classificador.

## Roadmap

- **WP-12C**: soak 30min/1h/2h e bursts (restart/cache frio).
