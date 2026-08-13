# Task 155 — Headroom ε no refill do limiter (correção mínima WP-12C)

**Execução de validação (código final):** cenário B, perfil `medium`, 10 clínicas, seed `wp12b-scale`
**Relatório:** `scenario-b-medium-2026-08-13T08-59-28-240Z.{json,md}` (+ dumps NDJSON `internal-events` / `mock-arrivals` / `correlated`)
**Resultado do harness:** ✅ PASS (0 critérios reprovados; zero duplicatas)

Execuções adicionais no mesmo dia: `08-25-31` (PASS, antes do ajuste do deadline LOW), `08-38-47` e `08-49-06` (única reprova: 1–2 POSTs OAuth duplicados com Δ3–11ms — o stampede de token já mapeado na #152, fora do escopo, não é escrita de negócio e independe do ε; os máximos de chegadas foram idênticos, 40/400 nas duas semânticas, em TODAS as execuções).

## O que foi implementado

Headroom temporal **ε = 300ms** (`REFILL_HEADROOM_MS`, configurável via `DOCTORALIA_REFILL_HEADROOM_MS`) no refill de TODAS as janelas deslizantes do limiter (`docplanner.service.ts`): WRITE/min, WRITE/h e agregado/5min. Cada evento passa a "ocupar" seu slot por `janela + ε`; com a janela cheia, o próximo grant só ocorre após `janela + ε` do evento mais antigo — tanto no cálculo do tempo de espera do pump quanto na eviction/contagem (para que um wakeup antecipado não fure o headroom).

**Justificativa do ε = 300ms:** dentro do intervalo recomendado pelo parecer (250–500ms); ~7× o jitter máximo de transporte medido no WP-12C (44ms; p99=16ms); cobre também a divergência de semântica inclusiva/estrita na fronteira exata; custo de throughput <1% (300ms a cada 60s).

**Ajustes decorrentes (tecnicamente indispensáveis para o ε funcionar):**
- O override `DOCTORALIA_REFILL_HEADROOM_MS` é CLAMPADO ao intervalo seguro [250, 500]ms — valor inválido → 300; 0/negativo nunca desabilita a proteção.
- O deadline da fila LOW passou de 60.000ms para `60s + ε + 700ms` (=61s): sem isso, um WRITE enfileirado logo após a janela/min encher (refill em 60,3s) expiraria por QueueTimeout ANTES do refill e seria descartado em vez de enviado. A semântica do deadline é a mesma; o critério do harness "oldest waiter dentro do deadline LOW" apenas acompanha o valor vigente (≤61s).

Nada mais foi alterado: budgets INTACTOS (40/min, 2.400/h, 400/5min — sem redução para 39/399), sem pacing/espaçamento mínimo entre grants (recomendação 2 fica para depois; não foi necessária para o ε funcionar), filas HIGH/LOW, `runWithPriority`, deadlines/dedup e critérios PASS/FAIL do harness inalterados.

## Resultado medido no MOCK (chegadas), nas DUAS semânticas

| Série | WRITE/60s inclusiva | WRITE/60s estrita | Agregado/5min inclusiva | Agregado/5min estrita |
|---|---|---|---|---|
| grants | **40** | **40** | **400** | **400** |
| dispatches | **40** | **40** | **400** | **400** |
| **arrivals** | **40** | **40** | **400** | **400** |
| limite | 40 | 40 | 400 | 400 |

Antes (WP-12C, sem ε): arrivals 42 WRITE em 59.995ms e 401 em 299.961ms. Agora, a janela ofensora de pico das chegadas WRITE tem span de apenas 1.882ms (burst interno bem longe da fronteira) — o padrão "extremos cravados a exatamente 60.000ms" desapareceu.

## Demais critérios do Done

- Correlação 664/664 (zero órfãos); jitter dispatch→arrival p99=20ms, máx=29ms (compatível com a base do ε).
- Filas drenando: HIGH pico 0, LOW drena a zero; **QueueFull=0, QueueTimeout=0**; oldest waiter dentro do deadline (máx 58.762ms ≤ 61s).
- Circuit breaker fechado durante toda a execução (nenhuma abertura registrada).
- Sem regressão GET/HIGH/LOW: grant→dispatch p99=0ms/máx=1ms; todas as 10 clínicas completaram full+vismed-full nas 2 janelas (0 failed/0 preso); latências comparáveis às execuções anteriores; shutdown limpo (SIGTERM, 20ms).
- Testes: suíte do limiter completa (7 suites, 107 testes) + nova cobertura de fronteira (`docplanner.service.refill-headroom.spec.ts`: nenhum grant antes de `janela+ε` com janela cheia — WRITE/min e agregado/5min; 41º WRITE LOW liberado após `janela+ε` e antes do deadline; clamp do override; grants normais fora da fronteira; eviction após `janela+ε`) e testes do harness (50) — todos verdes; typecheck limpo.

## Conclusão

A correção mínima do parecer WP-12C elimina o estouro nas fronteiras de janela: com ε=300ms, as CHEGADAS no destino respeitam ≤40 WRITE/60s e ≤400/5min em qualquer semântica de fronteira, mantendo os budgets integrais e sem custo perceptível de throughput.
