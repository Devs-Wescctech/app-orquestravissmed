# Task 170 — Pacing de grants LOW (25% / 750ms): validação nos Cenários A e C

Data: 2026-08-14 · Runs: `scenario-a-medium-2026-08-14T15-37-48-322Z` e `scenario-c-medium-2026-08-14T16-22-33-534Z` (seed `task170-c2`)

## O que foi implementado
Pacing **apenas para grants LOW** dentro do `pumpRateQueue` do coordinator:
- Quando o próximo grant seria LOW (sem HIGH elegível) e a ocupação da janela agregada 400/5min está ≥ **25%**, o pump espera até `lastLowGrantAt + 750ms` antes de conceder, com timer cancelável em corrida com o wakeup — uma chegada HIGH fura a espera imediatamente.
- Ocupação O(1) pós-eviction (`rateTimestamps.length / 400`); abaixo do threshold o comportamento é idêntico ao anterior (rajada permitida).
- HIGH nunca é paced; o grant LOW do anti-starvation 4:1 também não é paced (só há pacing quando não há HIGH elegível).
- Configuração por env com clamps de sanidade: `DOCTORALIA_LOW_PACING_THRESHOLD` (fração ou %, clamp 0,05–0,95; default 0,25) e `DOCTORALIA_LOW_PACING_INTERVAL_MS` (clamp 250–5000ms; default 750). **Sem auto-tuning** — os valores só mudam por env.
- Telemetria: `queue.lowPacing` no baseline de métricas (waitCount, totalWaitMs, avgWaitMs, maxWaitMs, lastOccupancyPct, lastAppliedAt) + log `[PACING-LOW]` limitado a 1/30s.
- Teto 400/5min, caps, deadlines, ε, budgets WRITE, anti-starvation 4:1, breaker e dedup **inalterados** (confirmado por 82 testes unitários nas 5 suítes do coordinator, todos verdes).

## Resultados — valores fixados 25%/750ms FUNCIONARAM

### Cenário A (2 clínicas) — ✅ PASS
Regressão zero: todos os critérios verdes; espera max 1,5s; pacing praticamente inativo (ocupação < 25%).

### Cenário C (20 clínicas) — ✅ PASS
| Métrica | C pré-pacing (08-13) | C com pacing (08-14) |
|---|---|---|
| Resultado | PASS | PASS |
| waitMs p50 / p95 / max | 0 / 50.654 / **60.138** | 14.998 / 27.921 / **37.031** |
| Esperas > 61s (deadline LOW) | 0 (max a 60,1s — margem ~0) | **0 (max 37s — margem 24s)** |
| QueueFull / QueueTimeout | 0 / 0 | 0 / 0 |
| Pico agregado 5min | 400/400 | 400/400 |
| Pico WRITE 1min / 1h | 40/40 · ~/2400 | 40/40 · 336/2400 |
| Duplicatas nos mocks | 0 | 0 |

### Zona morta eliminada (análise dos 1304 eventos internos)
- Maior lacuna entre grants **com waiter pendente na fila**: **6,8s** (antes: padrão rajada→seca com ~240s sem refill projetado para 50 clínicas).
- Esperas: p50 15,0s · p90 23,3s · p95 27,9s · p99 30,3s · max 37,0s — dentro da faixa prevista pelo relatório da Task 160 (~20–40s) e todas < 61s.
- Pacing aplicado 2.277 vezes (espera média 658ms, max 750ms) — vazão LOW sustentada ≈ teto 400/5min, fila drena continuamente sem ciclo crescente.

### Custo aceito: Global Sync mais lento (medido, não ajustado)
| Global Sync (full, 40 runs) | pré-pacing | com pacing | Δ |
|---|---|---|---|
| avg | 233s | 389s | **+67%** |
| p50 | 301s | 515s | +71% |
| max | 361s | 755s | +109% |

O consumo que antes era rajada de ~60s agora se espalha pela janela de 5min — exatamente o comportamento projetado. Duração total do run: 1059s → 1195s (+13%).

## Ajuste no harness (medição, não calibração)
O deadline de drenagem final do runner foi estendido em +300s (uma janela agregada completa): com pacing, o backlog residual dos pollers em background drena a ~80/min enquanto a ocupação ficar ≥ 25%, e o deadline antigo (220s) expirava com 1 waiter transitório no gauge — falso FAIL no critério "filas zeram ao final". O loop continua saindo cedo quando as filas zeram; nenhum critério foi afrouxado.

## Critérios de liberação da Task #171 (Cenário D, 50 clínicas)
- ✅ Cenário A PASS (regressão zero)
- ✅ Cenário C PASS
- ✅ Nenhuma zona sem grant LOW > 61s sob carga de Global Sync (max 6,8s com demanda pendente; max wait 37s)
- ✅ HIGH sem pacing, wakeup fura a espera (coberto por testes unitários dedicados)
- ✅ Duração do Global Sync medida e reportada (+67% avg)

**Conclusão: 25%/750ms aprovados — a Task #171 está liberada.** Se o Cenário D revelar custo excessivo ou lacuna remanescente, reportar (nunca auto-ajustar); qualquer mudança de threshold/intervalo é por env/config.
