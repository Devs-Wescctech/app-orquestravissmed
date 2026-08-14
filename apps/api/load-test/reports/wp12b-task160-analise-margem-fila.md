# Task 160 — Análise da margem de espera da fila do rate limiter (antes do Cenário D, 50 clínicas)

**Análise 100% read-only.** Nenhum código foi alterado. Fontes: relatórios versionados de A/B/C,
ndjson de eventos internos (grant/dispatch) e chegadas do mock do Cenário C
(`scenario-c-medium-2026-08-13T12-53-01-958Z-*`), Cenário B (`...11-39-39-753Z-*`) e leitura do
coordinator em `docplanner.service.ts`.

## 1. Métricas consolidadas (dos relatórios e ndjson)

| Métrica | A (2) | B (10) | C (20) |
|---|---|---|---|
| waitMs p50 / p90 / p95 / p99 / max | 0 / — / 0 / 1ms | 0 / 60ms / 21,8s / 58,8s / 58,96s | 0 / 11,5s / 50,7s / 60,12s / **60,138s** |
| Waiters >30s / >50s / >60s | 0 | 32 / 29 / 0 | 98 / 71 / **15** |
| QueueFull / QueueTimeout | 0/0 | 0/0 | 0/0 |
| Pico de waiters simultâneos (reconstruído do ndjson) | — | — | **21** (t≈594s) |
| Backlog final HIGH/LOW | 0/0 | 0/0 | 0/0 (drenagem dentro do prazo) |
| OAuth (todos via fila, classe WRITE) | 2 | 10 | 40 (0 duplicados) |
| Margem mínima até o deadline LOW de 61s | — | 2,0s | **862ms (1,4%)** |

Fases (C, por janelas de 30s, enq/grant): rajada inicial de **400 grants em ~60s** (Global Sync janela 1),
depois **zona morta de ~240s sem nenhum grant** (janela deslizante de 5min trancada), refill a ~80–100/min,
e novas mini-zonas mortas em t≈540–600s e t≈780–840s (Slot Sync + janela 2). O budget WRITE 40/min saturou
(exatamente 40/min) nos minutos 5–8, 10 e 13 — Slot Sync é WRITE-dominado e o WRITE/min é co-dominante
nessas fases.

## 2. Modelo da fila (reconstruído do código, read-only)

- Caps: HIGH=50, LOW=100 (`QUEUE_CAP_LOW` env-overridável). Deadlines: HIGH=15s;
  **LOW = 60.000 + ε(300) + 700 = 61.000ms** — derivado para acomodar exatamente UMA janela WRITE/min + ε.
- Grants: pump com prioridade HIGH, anti-starvation 4:1, GET fura WRITE inelegível; ε=300ms aplicado
  na eviction das três janelas (400/5min, 40/min, 2.400/h).
- Propriedade estrutural chave: **cada fluxo enfileira 1 requisição por vez** (sequencial). A profundidade
  da fila é limitada pelo nº de fluxos concorrentes (~1 por clínica + pollers), não pelo total de chamadas.
  Por isso pico=21 waiters com 20 clínicas e QueueFull=0 mesmo com LOW cap=100.
- Consequência: **o tempo do oldest waiter NÃO é controlado pelo sistema** — é a distância entre o instante
  de chegada e a próxima eviction da janela agregada/WRITE. O deadline LOW de 61s só cobre a espera de UMA
  janela de 1min; a janela agregada de 5min pode criar esperas potenciais de até ~240s.

## 3. Por que o oldest waiter encostou em 60,1s (e por que C passou "por sorte")

A rajada inicial consome os 400 slots em ~60s e tranca a janela até t≈300s+ε. Qualquer requisição LOW que
chegue **mais de 61s antes da primeira eviction** expira (QueueTimeout). Em C, os fluxos estavam ocupados com
a fase VisMed (64,5 mil chamadas) durante a zona morta e as chegadas só voltaram em t=248s — 52s antes do
refill — e em t=301s (grant em t=361s, espera 60,1s, margem de 862ms). O mesmo padrão se repete nas
mini-zonas mortas seguintes (esperas de 53–57s). Ou seja: **o critério passou porque o alinhamento de fases
(duração VisMed × ciclo de 5min) posicionou as chegadas dentro dos últimos 61s da zona morta — não há nenhum
mecanismo garantindo isso.** Não é cap (21/100), não é ε (300ms corretos), não é budget excedido: é a
**burstiness do consumo da janela deslizante** (400 em 1min → 4min de seca) contra um deadline de fila de 61s.

## 4. OAuth ×4 para carga ×2 — explicado (não é a fila nem duplicação)

- 40 auths = 20 em t≈0s + **20 em t≈566–601s = 12:45:00 UTC em relógio de parede**.
- Causa: `TokenRefresherService` roda em cron `*/15` e **não é desabilitado pelo harness**
  (o env só desliga `DISABLE_SYNC_CRON`, `DISABLE_BOOKING_SWEEP`, `DISABLE_BLOCK_WATCHER`).
  Sua margem de renovação é 2h, mas o mock emite `expires_in=3600` (TTL efetivo 59min) —
  **TTL < margem ⇒ todo tick do cron força refresh de TODAS as clínicas.**
- B (11:30:52→11:39:39) não cruzou nenhum tick de :15 ⇒ 1,0 auth/clínica. C (12:35→12:53) cruzou o tick
  de 12:45 ⇒ 2,0 auth/clínica. É aliasing de relógio de parede, não função da carga. Single-flight OK
  (0 duplicados; correlação 1365/1365).
- Efeito colateral relevante: cada auth é POST classe WRITE **dentro da fila**; no tick de 12:45 uma auth
  esperou 35,3s. Com 50 clínicas, um tick despeja 50 WRITEs de auth de uma vez (> budget de 40/min sozinho).

## 5. Projeção para o Cenário D (50 clínicas)

- Volume: ~1.365 × 2,5 ≈ **3.400 chamadas Doctoralia**; sob o teto de 400/5min (80/min médios) o tempo
  mínimo só de vazão é ~43min ⇒ duração ≥ ~45min ⇒ cruza **3 ticks** do refresher ⇒ até **200 auths**
  (50 + 3×50), todas WRITE, em rajadas de 50 (>40/min).
- Filas: pico de waiters ≈ 50–55 (1 por fluxo) ⇒ LOW cap=100 ainda OK (margem ~45%), HIGH intocada.
  **Cap não é o gargalo.**
- Oldest waiter: a zona morta continua com ~240s de exposição e o deadline LOW cobre só 61s. Com 2,5× mais
  fluxos, fases mais longas e 3 rajadas de auth, a probabilidade de alguma chegada LOW cair a >61s de uma
  eviction tende a 1. Em C a margem já era 862ms. **Previsão: QueueTimeout > 0 no D**, e como
  QueueTimeout é NON-RETRYABLE (WP-07), syncs falham ⇒ além do critério "oldest ≤61s", caem também
  "QueueTimeout=0" e possivelmente "toda clínica completa".
- HIGH/UI: durante as zonas mortas o deadline HIGH de 15s já não é atendível nem com 20 clínicas
  (primeira eviction pode estar a 240s). O harness não exercita HIGH, mas em produção um clique de UI
  durante Global Sync receberia QueueTimeout — risco já existente, não introduzido pelo D.

## 6. Veredito

**(b) A fila atual NÃO suporta o Cenário D como está** — mas o gargalo **não** é cap, deadline, ε nem
budget: é o padrão rajada-e-seca do consumo da janela de 5min. Elevar LOW/HIGH/deadlines não resolveria
(e é vetado). Duas propostas mínimas, submetidas para aprovação — **nada implementado nesta task**:

1. **Pacing do pump (ajuste mínimo recomendado):** quando a janela agregada passar de um limiar de ocupação
   (ex.: ≥50%), espaçar grants LOW para ~a taxa média da janela (1 grant/~750ms ⇒ ≤80/min). Elimina a zona
   morta de 4min (evictions ficam contínuas), o oldest waiter passa a ser ≈ backlog/vazão (~20–40s com 50
   fluxos) e HIGH/UI sempre encontra eviction próxima. Trade-off: a janela 1 do Global Sync termina em ~5min
   em vez de ~1min de rajada + 4min de seca — duração total praticamente igual (o processo já é limitado
   pelo budget). Não altera budgets, caps, deadlines, ε, breaker, retry, dedup nem scheduler.
2. **Correção do harness (complementar, sem tocar produção):** desligar o TokenRefresher no harness
   (novo env `DISABLE_TOKEN_REFRESHER`) ou emitir `expires_in` > 2h no mock, para o D não somar ~150 auths
   WRITE de artefato de teste. Alternativa zero-código: nenhuma — o cron não tem flag hoje.

Sem a proposta 1, rodar o D como está deve reprovar em oldest waiter/QueueTimeout por construção, ainda que
os budgets externos (WAF) continuem 100% respeitados — o risco é de critério interno, não de estouro real
do limite da Doctoralia.
