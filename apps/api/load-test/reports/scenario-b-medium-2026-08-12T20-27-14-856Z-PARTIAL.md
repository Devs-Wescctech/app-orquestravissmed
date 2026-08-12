# Relatório de carga — WP-12A/12B (cenário b, perfil medium) — ⚠️ PARCIAL

- **Resultado:** ❌ FAIL (relatório PARCIAL — execução interrompida)
- **Motivo da interrupção:** slot-sync lt-clinic-1 (janela 1) falhou nas 3 tentativas
- Seed: `wp12b-scale` · Duração: 163.2s · 2026-08-12T20:24:31.608Z → 2026-08-12T20:27:14.856Z
- TLS: NODE_EXTRA_CA_CERTS apontando para o cert de teste no env do processo filho (abordagem preferida do plano; validação TLS permanece ativa)

## Critérios
| Critério | Resultado | Detalhe |
|---|---|---|
| Baseline de métricas coletado com sucesso (snapshots válidos, último válido) | ✅ | 30/30 snapshots válidos |
| Nenhuma rota não-mapeada nos mocks | ✅ | 0 rota(s): — |
| Budget agregado 400/5min nunca excedido (mock Doctoralia) | ✅ | pico 399/400 |
| Budget WRITE 40/min nunca excedido | ❌ | pico 41/40 |
| Budget WRITE 2.400/h nunca excedido | ✅ | pico 120/2400 |
| Zero escrita duplicada nos mocks (janela 120s) | ❌ | 1 duplicata(s) |
| Filas HIGH/LOW retornam a 0 ao final (dado ausente reprova) | ❌ | final high=0 low=8 |
| Oldest waiter dentro dos deadlines (≤60s; timeouts=0; dado ausente reprova) | ✅ | waitMs.max=58181, QueueTimeout=0 |
| Toda clínica completa full+vismed-full em 2 janela(s) (0 failed, 0 preso) | ❌ | failed=0, running=0, clínicas esperadas=10 |
| Reservas expiradas = 0 (exige baseline válido) | ✅ | expiradas=0 |
| Memória RSS estabiliza (sem crescimento monotônico) | ✅ | deltas não-negativos=82%, crescimento do último quartil=3.8% (falha se ≥90% e ≥10%) |
| Heap usado estabiliza (sem crescimento monotônico) | ✅ | deltas não-negativos=70%, crescimento do último quartil=-3.7% (falha se ≥90% e ≥10%) |
| QueueFull/QueueTimeout = 0 | ✅ | QueueFull=0, QueueTimeout=0 |
| API encerra limpa (SIGTERM, sem Promise/timer órfão segurando o processo) | ❌ | SEM DADO (shutdown não medido — reprova) |

## Budgets (auditados no mock Doctoralia)
- Agregado 5min: pico **399** / 400
- WRITE 1min: pico **41** / 40
- WRITE 1h: pico **120** / 2400

## Mocks
- **doctoralia**: 399 chamadas (279 GET, 120 WRITE), duplicatas=1, paths não-mapeados=0
- **vismed**: 3940 chamadas (3940 GET, 0 WRITE), duplicatas=0, paths não-mapeados=0

## Comparação de contadores (mock vs. baseline)
- API: mock=388, baseline=388, Δ=0
- OAuth: mock=11, baseline=11

## Comparação com o baseline A
- Baseline: `scenario-a-medium-2026-08-12T20-12-41-932Z.json` (cenário a, 2026-08-12T20:12:41.932Z) · fator de clínicas: ×5

| Métrica | Baseline A | Este cenário | Fator |
|---|---|---|---|
| Duração total (ms) | 55678 | 163248 | ×2.93 |
| Duração média Global Sync (ms) | 306 | 500 | ×1.63 |
| GETs Doctoralia (mock) | 97 | 279 | ×2.88 |
| WRITEs Doctoralia (mock) | 36 | 120 | ×3.33 |
| Pico agregado 5min | 133 | 399 | ×3 |
| Pico WRITE/min | 36 | 41 | ×1.14 |
| Pico WRITE/h | 36 | 120 | ×3.33 |
| Pico fila HIGH | 0 | 0 | ×1 |
| Pico fila LOW | 0 | 8 | — |
| Espera p50 (ms) | 0 | 0 | ×1 |
| Espera p95 (ms) | 0 | 57816 | — |
| Espera max (ms) | 1 | 58181 | ×58181 |
| QueueFull | 0 | 0 | ×1 |
| QueueTimeout | 0 | 0 | ×1 |
| Skips do concurrency guard | 2 | 113 | ×56.5 |
| Reservas de prioridade expiradas | 0 | 0 | ×1 |
| RSS máx (bytes) | 170123264 | 175198208 | ×1.03 |
| Heap máx (bytes) | 36896904 | 54992600 | ×1.49 |
| Event-loop lag p95 máx (ms) | 21.643263 | 27.377663 | ×1.26 |
| Postgres conexões máx | 11 | 16 | ×1.45 |
| Postgres QPS máx | 116.8 | 468.2 | ×4.01 |
| Backlog final HIGH | 0 | 0 | ×1 |
| Backlog final LOW | 0 | 8 | — |

- **Crescimento relativo** (esperado ~×5 se linear): duração ×2.93, chamadas ×3, memória ×1.03, pico de fila ×—, espera p95 ×—

## Filas
- waitMs p50=0 p95=57816 max=58181 · QueueFull=0 QueueTimeout=0

## Global sync por clínica
- lt-clinic-1: completed=1 failed=0 running=0 (vismed-full:completed 551ms, full:push_to_doctoralia)
- lt-clinic-2: completed=1 failed=0 running=0 (vismed-full:completed 487ms, full:push_to_doctoralia)
- lt-clinic-3: completed=1 failed=0 running=0 (vismed-full:completed 527ms, full:push_to_doctoralia)
- lt-clinic-4: completed=1 failed=0 running=0 (vismed-full:completed 472ms, full:push_to_doctoralia)
- lt-clinic-5: completed=1 failed=0 running=0 (vismed-full:completed 497ms, full:push_to_doctoralia)
- lt-clinic-6: completed=1 failed=0 running=0 (vismed-full:completed 511ms, full:push_to_doctoralia)
- lt-clinic-7: completed=1 failed=0 running=0 (vismed-full:completed 506ms, full:push_to_doctoralia)
- lt-clinic-8: completed=1 failed=0 running=0 (vismed-full:completed 522ms, full:push_to_doctoralia)
- lt-clinic-9: completed=1 failed=0 running=0 (vismed-full:completed 489ms, full:push_to_doctoralia)
- lt-clinic-10: completed=1 failed=0 running=0 (vismed-full:completed 436ms, full:push_to_doctoralia)

## Processo sob teste
- RSS: max 167.1 MB · heapUsed max 52.4 MB
- Event-loop lag: mean p50=20.22ms, mean max=23.40ms, p95 max=27.38ms (31 amostras via preload)

## Postgres de teste
- Conexões máx: 16 · QPS máx (xact/s): 468.2 · pg_stat_statements: disponível
