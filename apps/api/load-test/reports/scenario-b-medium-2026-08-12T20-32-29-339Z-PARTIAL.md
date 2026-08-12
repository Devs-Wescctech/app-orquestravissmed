# Relatório de carga — WP-12A/12B (cenário b, perfil medium) — ⚠️ PARCIAL

- **Resultado:** ❌ FAIL (relatório PARCIAL — execução interrompida)
- **Motivo da interrupção:** slot-sync lt-clinic-1 (janela 1) não conseguiu executar em 110s (guard ocupado além do deadline)
- Seed: `wp12b-scale` · Duração: 259.0s · 2026-08-12T20:28:10.361Z → 2026-08-12T20:32:29.339Z
- TLS: NODE_EXTRA_CA_CERTS apontando para o cert de teste no env do processo filho (abordagem preferida do plano; validação TLS permanece ativa)

## Critérios
| Critério | Resultado | Detalhe |
|---|---|---|
| Baseline de métricas coletado com sucesso (snapshots válidos, último válido) | ✅ | 49/49 snapshots válidos |
| Nenhuma rota não-mapeada nos mocks | ✅ | 0 rota(s): — |
| Budget agregado 400/5min nunca excedido (mock Doctoralia) | ✅ | pico 400/400 |
| Budget WRITE 40/min nunca excedido | ❌ | pico 42/40 |
| Budget WRITE 2.400/h nunca excedido | ✅ | pico 122/2400 |
| Zero escrita duplicada nos mocks (janela 120s) | ✅ | 0 duplicata(s) |
| Filas HIGH/LOW retornam a 0 ao final (dado ausente reprova) | ❌ | final high=0 low=10 |
| Oldest waiter dentro dos deadlines (≤60s; timeouts=0; dado ausente reprova) | ✅ | waitMs.max=58075, QueueTimeout=0 |
| Toda clínica completa full+vismed-full em 2 janela(s) (0 failed, 0 preso) | ❌ | failed=0, running=0, clínicas esperadas=10 |
| Reservas expiradas = 0 (exige baseline válido) | ✅ | expiradas=0 |
| Memória RSS estabiliza (sem crescimento monotônico) | ✅ | deltas não-negativos=56%, crescimento do último quartil=0.7% (falha se ≥90% e ≥10%) |
| Heap usado estabiliza (sem crescimento monotônico) | ✅ | deltas não-negativos=51%, crescimento do último quartil=0.2% (falha se ≥90% e ≥10%) |
| QueueFull/QueueTimeout = 0 | ✅ | QueueFull=0, QueueTimeout=0 |
| API encerra limpa (SIGTERM, sem Promise/timer órfão segurando o processo) | ❌ | SEM DADO (shutdown não medido — reprova) |

## Budgets (auditados no mock Doctoralia)
- Agregado 5min: pico **400** / 400
- WRITE 1min: pico **42** / 40
- WRITE 1h: pico **122** / 2400

## Mocks
- **doctoralia**: 400 chamadas (278 GET, 122 WRITE), duplicatas=0, paths não-mapeados=0
- **vismed**: 3940 chamadas (3940 GET, 0 WRITE), duplicatas=0, paths não-mapeados=0

## Comparação de contadores (mock vs. baseline)
- API: mock=386, baseline=386, Δ=0
- OAuth: mock=14, baseline=14

## Comparação com o baseline A
- Baseline: `scenario-a-medium-2026-08-12T20-12-41-932Z.json` (cenário a, 2026-08-12T20:12:41.932Z) · fator de clínicas: ×5

| Métrica | Baseline A | Este cenário | Fator |
|---|---|---|---|
| Duração total (ms) | 55678 | 258978 | ×4.65 |
| Duração média Global Sync (ms) | 306 | 506 | ×1.65 |
| GETs Doctoralia (mock) | 97 | 278 | ×2.87 |
| WRITEs Doctoralia (mock) | 36 | 122 | ×3.39 |
| Pico agregado 5min | 133 | 400 | ×3.01 |
| Pico WRITE/min | 36 | 42 | ×1.17 |
| Pico WRITE/h | 36 | 122 | ×3.39 |
| Pico fila HIGH | 0 | 0 | ×1 |
| Pico fila LOW | 0 | 10 | — |
| Espera p50 (ms) | 0 | 0 | ×1 |
| Espera p95 (ms) | 0 | 57648 | — |
| Espera max (ms) | 1 | 58075 | ×58075 |
| QueueFull | 0 | 0 | ×1 |
| QueueTimeout | 0 | 0 | ×1 |
| Skips do concurrency guard | 2 | 183 | ×91.5 |
| Reservas de prioridade expiradas | 0 | 0 | ×1 |
| RSS máx (bytes) | 170123264 | 176607232 | ×1.04 |
| Heap máx (bytes) | 36896904 | 53810984 | ×1.46 |
| Event-loop lag p95 máx (ms) | 21.643263 | 29.802495 | ×1.38 |
| Postgres conexões máx | 11 | 18 | ×1.64 |
| Postgres QPS máx | 116.8 | 360.3 | ×3.08 |
| Backlog final HIGH | 0 | 0 | ×1 |
| Backlog final LOW | 0 | 10 | — |

- **Crescimento relativo** (esperado ~×5 se linear): duração ×4.65, chamadas ×3.01, memória ×1.04, pico de fila ×—, espera p95 ×—

## Filas
- waitMs p50=0 p95=57648 max=58075 · QueueFull=0 QueueTimeout=0

## Global sync por clínica
- lt-clinic-1: completed=1 failed=0 running=0 (vismed-full:completed 497ms, full:push_to_doctoralia)
- lt-clinic-2: completed=1 failed=0 running=0 (vismed-full:completed 503ms, full:push_to_doctoralia)
- lt-clinic-3: completed=1 failed=0 running=0 (vismed-full:completed 467ms, full:push_to_doctoralia)
- lt-clinic-4: completed=1 failed=0 running=0 (vismed-full:completed 492ms, full:push_to_doctoralia)
- lt-clinic-5: completed=1 failed=0 running=0 (vismed-full:completed 483ms, full:push_to_doctoralia)
- lt-clinic-6: completed=1 failed=0 running=0 (vismed-full:completed 520ms, full:push_to_doctoralia)
- lt-clinic-7: completed=1 failed=0 running=0 (vismed-full:completed 542ms, full:push_to_doctoralia)
- lt-clinic-8: completed=1 failed=0 running=0 (vismed-full:completed 543ms, full:push_to_doctoralia)
- lt-clinic-9: completed=1 failed=0 running=0 (vismed-full:completed 535ms, full:push_to_doctoralia)
- lt-clinic-10: completed=1 failed=0 running=0 (vismed-full:completed 479ms, full:push_to_doctoralia)

## Processo sob teste
- RSS: max 168.4 MB · heapUsed max 51.3 MB
- Event-loop lag: mean p50=20.23ms, mean max=23.53ms, p95 max=29.80ms (50 amostras via preload)

## Postgres de teste
- Conexões máx: 18 · QPS máx (xact/s): 360.3 · pg_stat_statements: disponível
