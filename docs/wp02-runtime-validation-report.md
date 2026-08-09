# WP-02 — Relatório de Validação Runtime Final (Task #105 / ClinicConcurrencyGuard)

Coleta READ-ONLY de runtime no ambiente TESTE (workspace Replit, workflow "Start application"). Nenhum parâmetro alterado; nenhuma concorrência provocada artificialmente. Somente dados reais observados.

## 1. Código carregado

- **Commit SHA em execução:** `60d938778b836469ecc01c1d06fd9ce7b4e2514c`
- **Branch:** `main`
- **`git status --short` (pré-coleta):** limpo (nenhuma saída)
- **Implementação da #105 carregada:** confirmada. `apps/api/dist/bookings/clinic-concurrency-guard.js` (código compilado em execução) contém `tryAcquire` com a barreira `active.size > 0` — rejeita quando QUALQUER subsistema está ativo na clínica (exclusão mútua atômica, política SKIP).

## 2. Janela de coleta

- **Início da janela (reset do baseline):** 2026-08-09T21:35:14.387Z (`POST /metrics/doctoralia-baseline/reset` → `{"ok":true}`)
- **generatedAt:** 2026-08-09T21:40:27.913Z
- **Duração real:** 313.526 ms (~5min 14s) — `measurementPeriodMs: 313526`
- **dataSource:** `live`
- **measurementScope:** instância `08845aa4-...:fkar77k4`, escopo `UNKNOWN` (métricas representam apenas este processo — nota padrão do endpoint)
- **Clínicas monitoradas (polling ativo):** 1 (`clinicsPolled: 1`, clinicId `26ff6320-4b86-453b-b468-967dd0711e0e` — VisMed Central Clinic)

Observação: o servidor havia sido reiniciado às 21:34:39Z; o reset do baseline às 21:35:14Z definiu a janela limpa.

## 3. Volume Doctoralia

| Métrica | Valor |
|---|---|
| Total de requests Doctoralia | 16 |
| POLLING | 11 |
| SAFETY_SWEEP | 5 |
| SCHEDULER | 0 (não presente em `byOrigin`) |
| USER_INTERACTIVE | 0 (não presente em `byOrigin`) |
| OAuth (`DOCTORALIA_OAUTH_REQUEST_COUNT`) | 0 |

## 4. Rate limit / Fila

- **used (janela 5min):** 15 (pico 15, mínimo 2, atual 15)
- **remaining:** 385 (máx. 398, mín. 385) — teto 400/5min longe de saturação
- **wait (fila de vazão):** p50 = 0 ms, p95 = 0 ms, p99 = 0 ms, máximo = 0 ms; buckets: 16 requisições em `<1s`, zero nas demais faixas
- **Filas:** `DOCTORALIA_QUEUE_SIZE_HIGH` = 0 (pico 0), `DOCTORALIA_QUEUE_SIZE_LOW` = 0 (pico 0)
- **Bloqueios do RateLimiterService:** `blockedRequests` = 0 (16 eventos, wait p50/p95/máx = 0 ms)
- Snapshots de rate: 16, último em 2026-08-09T21:40:16.863Z

## 5. Erros (Doctoralia)

O objeto `errors` do baseline retornou vazio — **zero erros Doctoralia** na janela:

- 401: 0
- 404: 0
- 409: 0
- timeout: 0
- network: 0
- outros: 0

Anomalia observada FORA do escopo Doctoralia (registrada, não corrigida): a API da VisMed (`app.vissmed.com.br/api-vissmed-5/...`) respondeu **HTTP 404** consistentemente durante toda a janela (`get-agendamento-filtros` e `bloqueios-profissional-by-idempresagestora`). O poll tratou como falha de fetch (`fetchSuccess=false`) e, corretamente, não disparou reconciliação destrutiva. Isso não afeta as métricas Doctoralia nem a validação do guard.

## 6. Polling

- **Ciclos de polling concluídos:** 11 (`totalCompletedPolls`), consistente com o intervalo de ~30s na janela de ~5min; 12 ciclos "No notifications" registrados no log desde o boot
- **Clínicas:** 1
- **MAX_CONCURRENT_POLLS:** 1
- **Polls ativos (no momento do snapshot):** 0
- **OVERLAPPING_POLL_DETECTED:** 0 (`OVERLAPPING_POLL_COUNT: 0`, `recentOverlaps: []`)

## 7. Safety Sweep

- **Sweeps executados na janela:** 1 ciclo — log: `[SAFETY-SWEEP] Ciclo concluído em 2s: nenhum booking perdido (1 clínica(s)).` às 21:35:44Z (intervalo configurado: 20 min; próximo ciclo fora da janela)
- **Requests do sweep:** 5 (origem SAFETY_SWEEP no baseline)
- **Clínicas varridas:** 1

## 8. ClinicConcurrencyGuard (Task #105)

Contadores de skip por concorrência (obrigatórios):

| Contador | Valor |
|---|---|
| POLL_SKIPPED_POLL_ACTIVE | 0 |
| POLL_SKIPPED_SWEEP_ACTIVE | 0 |
| SWEEP_SKIPPED_POLL_ACTIVE | 0 |
| SWEEP_SKIPPED_SWEEP_ACTIVE | 0 |

Zero skips é o resultado esperado em janela normal com 1 clínica: poll (~30s, execução de poucos segundos) e sweep (20 min, 2s de execução) raramente colidem. Nenhum log `POLL_SKIPPED_*` / `SWEEP_SKIPPED_*` na janela — coerente com os contadores.

## 9. Duplicidades

- **POTENTIAL_DUPLICATE_REQUEST_COUNT:** 5 — todas com a mesma assinatura `GET GET_NOTIFICATIONS /api/v3/integration/notifications/multiple?limit=100` (origem POLLING, mesma clínica).
- Interpretação (registro, sem correção): são leituras periódicas legítimas do endpoint de notificações que caem na janela de 30s do detector de duplicatas quando ciclos consecutivos se aproximam. Não há duplicidade de bookings/breaks; nenhuma escrita duplicada observada. Anomalia conhecida do detector, já coberta pela task de otimização de leituras duplicadas por ciclo de polling.

## 10. Integridade git pós-coleta

- `git status --short` → vazio*
- `git diff --name-only` → vazio
- `git diff --stat` → vazio

\* Executado imediatamente antes da criação deste arquivo; `docs/wp02-runtime-validation-report.md` é o único arquivo novo (untracked), conforme autorizado pela task. Nenhum commit e nenhum push realizados.

## 11. Conclusão

### Runtime: **SAUDÁVEL**
16 requests Doctoralia em ~5min (used 15/400), fila zerada, wait 0 ms, zero bloqueios, zero erros Doctoralia, zero overlaps de poll. A única anomalia é externa (VisMed API 404), tratada de forma fail-safe pelo sistema.

### Exclusão mútua
- **Evidência observada:** guard #105 carregado no código compilado em execução; instrumentação ativa (contadores expostos em `concurrencyGuard` no baseline); `OVERLAPPING_POLL_DETECTED = 0` e `MAX_CONCURRENT_POLLS = 1` (nenhuma execução concorrente ocorreu); polling e sweep executaram normalmente na janela sem corrupção nem duplicidade de escrita.
- **Evidência não observada:** nenhum evento de skip real (todos os contadores em 0) — não houve colisão natural entre poll e sweep na janela, portanto o bloqueio em runtime não foi exercitado nesta coleta. Isso é esperado e NÃO constitui falha: a exclusão mútua é comprovada pelos testes automatizados da #105.

### Task #105: **VALIDADA**
Implementação presente e carregada, instrumentação funcionando, nenhuma regressão operacional (sem overlaps, sem duplicidades de escrita, sem erros novos), e comportamento em janela normal exatamente o esperado (zero skips). A garantia formal de exclusão mútua permanece coberta pelos testes automatizados.

---
*Coleta realizada em 2026-08-09, janela 21:35:14Z → 21:40:27Z, ambiente TESTE (workspace Replit).*
