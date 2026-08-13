# WP-12B — Cenário C (20 clínicas, medium, wp12b-scale): análise A → B → C

- **Execução:** 2026-08-13T12:35:22Z → 12:53:01Z (única, via harness existente, sem alteração de código produtivo)
- **Relatórios base:**
  - C: `scenario-c-medium-2026-08-13T12-53-01-958Z.{json,md}` (✅ PASS, 14/14 critérios do harness)
  - B: `scenario-b-medium-2026-08-13T11-39-39-753Z.md` (último B aprovado, pós single-flight OAuth)
  - A: `scenario-a-medium-2026-08-12T20-12-41-932Z.md` (baseline, 2 clínicas)
- **Nota:** os JSONs de A e B não persistem no repositório (`*.json` está no `.gitignore`), então a comparação
  automática do runner foi omitida; os fatores abaixo foram calculados manualmente a partir dos `.md` versionados.

## Classificação final: 🟡 PASS COM PRESSÃO

Todos os critérios obrigatórios passaram, mas há indicadores encostados no teto que precisam ser analisados
antes de rodar o Cenário D (50 clínicas). **Não executar D até resolver a análise da fila LOW (oldest waiter).**

## Tabela comparativa A → B → C

| Métrica | A (2) | B (10) | C (20) | C/A (esp. ×10) | C/B (esp. ×2) |
|---|---|---|---|---|---|
| Duração total | 55,7s | 527,3s | 1.059,2s | ×19,0 | ×2,01 |
| GETs Doctoralia (mock) | 97 | 485 | 1.025 | ×10,6 | ×2,11 |
| WRITEs Doctoralia (mock) | 36 | 171 | 340 | ×9,4 | ×1,99 |
| Total chamadas Doctoralia | 133 | 656 | 1.365 | ×10,3 | ×2,08 |
| Pico WRITE/60s (limite 40) | 36 | 40 | **40 (100%)** | — | ×1,0 (teto) |
| Pico agregado/5min (limite 400) | 133 | 400 | **400 (100%)** | — | ×1,0 (teto) |
| Pico WRITE/h (limite 2.400) | 36 | 171 | 340 (14%) | ×9,4 | ×1,99 |
| OAuth total (duplicados=0) | 2 | 10 | **40** | ×20 | **×4,0** ⚠️ |
| Espera fila p95 | 0ms | 21,8s | 50,7s | — | **×2,32** ⚠️ |
| Espera fila p99 / max | 1ms | — / 59,0s | 60,1s / **60,1s** | — | ×1,02 (98,6% do teto de 61s) ⚠️ |
| QueueFull / QueueTimeout | 0/0 | 0/0 | 0/0 | — | — |
| Circuit breaker (aberturas/transições) | 0 | 0 | 0 (`byDomain={}`) | — | — |
| Guard: skips totais | — | — | 587 (472 poll×global-sync, 67 poll×poll, 30 sweep, 18 slot) | — | — |
| Reservas expiradas | 0 | 0 | 0 | — | — |
| Global Sync completed/failed/preso | 8/0/0 | 40/0/0 | 80/0/0 (20/20 clínicas) | — | — |
| Global Sync full (janela 1) | ~0,6s | 183–301s | 300–361s | — | ×~1,2 |
| Global Sync full (janela 2) | ~0,4s | ~1s | **53–170s** | — | **super-linear** ⚠️ |
| Backlog final HIGH/LOW | 0/0 | 0/0 | 0/0 (filas drenadas) | — | — |
| RSS máx | 162,2 MB | 181,8 MB | 178,5 MB | ×1,10 | ×0,98 ✅ |
| Heap máx | 35,2 MB | 52,7 MB | 54,6 MB | ×1,55 | ×1,04 ✅ |
| Estabilidade de memória | estável | estável | estável (últ. quartil RSS −3,4%, heap +2,3%) | — | — |
| Event-loop lag p95 máx | 21,6ms | 35,7ms | 34,0ms | ×1,57 | ×0,95 ✅ |
| Postgres conexões máx / QPS máx | 11 / 117 | 18 / 1.054 | 18 / 955 | — | ×1,0 / ×0,91 ✅ |
| Encerramento limpo (SIGTERM) | ✅ 8ms | ✅ 16ms | ✅ 12ms | — | — |
| Escritas duplicadas | 0 | 0 | 0 | — | — |

## Critérios obrigatórios — veredito

| Critério | Veredito |
|---|---|
| WRITE ≤ 40 em qualquer janela de 60s | ✅ pico exatamente 40/40 (limiter segurou; auditado no mock, grants=dispatches=arrivals=40) |
| Agregado ≤ 400 em qualquer janela de 5min | ✅ pico exatamente 400/400 |
| Zero OAuth duplicado | ✅ mock=baseline=40, Δ=0; correlação 1365/1365 sem chamadas órfãs (single-flight sustentado) |
| Zero escrita duplicada | ✅ 0 duplicatas nos dois mocks (janela 120s) |
| Filas drenadas ao final | ✅ HIGH=0, LOW=0 no encerramento |
| Nenhuma reserva expirada | ✅ 0 |
| Nenhuma abertura indevida do circuit breaker | ✅ nenhuma transição registrada (`byDomain={}`) |
| Nenhuma clínica permanentemente sem Global Sync | ✅ 20/20 com completed=4, failed=0, running=0 |

## Indicadores de pressão (motivo do 🟡)

1. **Oldest waiter a 98,6% do teto** — espera máxima na fila foi 60,1s contra o limite de 61s (60s+ε).
   15 requisições ficaram no bucket >60s. Com o dobro de backlog no Cenário D, este critério quase
   certamente estoura sem qualquer mudança de comportamento — é o primeiro limite que vai saturar.
2. **p95 de espera cresceu ×2,32 para carga ×2** (21,8s → 50,7s) — degradação levemente super-linear;
   o p99 (60,1s) já encostou no máximo, sinal de fila comprimida contra o teto do rate limiter.
3. **OAuth ×4 para carga ×2** (10 → 40; 1,0 → 2,0 por clínica). Sem duplicação concorrente (single-flight
   OK), mas o crescimento super-linear de autenticações merece explicação antes de D (provável renovação
   por janela em execução mais longa; a duração ~17,6min ainda está longe do TTL de ~1h do token).
4. **Global Sync da janela 2 saltou de ~1s (B) para 53–170s (C)** — o backlog residual da janela 1 sob o
   teto fixo de 400/5min derrama para a janela seguinte; comportamento esperado de saturação, mas confirma
   que a vazão total já está no limite do budget, não da arquitetura.

**Saudáveis e lineares/sub-lineares:** chamadas (×2,08), duração (×2,01), memória (estável, ×~1,0),
event-loop lag (×0,95), Postgres (conexões constantes, QPS ×0,91), encerramento limpo, zero erros.

## Conclusão

A arquitetura em si escala de forma linear e estável até 20 clínicas — CPU, memória, event loop, Postgres e
concorrência estão saudáveis. A pressão vem inteiramente da fila do rate limiter operando colada nos budgets
(40/min e 400/5min): com 20 clínicas o oldest waiter já consome 98,6% da margem do deadline de espera.
**Não avançar para o Cenário D (50 clínicas) antes de analisar a margem de espera da fila LOW** — na carga
×2,5 o critério de oldest waiter ≤61s deve falhar, ainda que os budgets externos continuem respeitados.
