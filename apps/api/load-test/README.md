# Harness de carga do módulo de sincronização (WP-12A)

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

## Roadmap

- **WP-12B**: cenários de 10/20/50 clínicas + comparação automática com baseline.
- **WP-12C**: soak 30min/1h/2h e bursts (restart/cache frio).
- **WP-13**: injeção de falhas (429, 503, timeout, WAF) nos mocks.
