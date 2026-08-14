# Roadmap de Confiabilidade e Escalabilidade Doctoralia/VisMed — Estado Final

> Documento de encerramento administrativo do roadmap. Consolida o checkpoint
> final aprovado. Atividade exclusivamente de documentação — nenhum código,
> banco, schema, migration ou configuração de produção foi alterado.

---

## Contexto

Esta frente foi criada para tornar a integração Doctoralia/VisMed **confiável e
escalável** diante de:

- múltiplas clínicas ativas simultaneamente;
- sincronizações concorrentes (polling, Safety Sweep, Global Sync, UI);
- limites de taxa e WAF da Doctoralia;
- polling e Global Sync periódicos.

---

## Arquitetura final

Cadeia consolidada de proteção das chamadas à Doctoralia:

```
Pollers / Global Sync / Safety Sweep / UI
        → ClinicConcurrencyGuard
        → Request Coordinator
        → Backpressure + LOW pacing
        → Rate Limiter + budgets GET/WRITE + headroom ε
        → GET dedup + cache TTL + retry
        → Circuit Breaker
        → OAuth single-flight
        → Doctoralia
```

Complementos estruturais da arquitetura:

- **Stagger determinístico do Global Sync** — syncs das clínicas escalonados na janela do cron.
- **Reserva de prioridade do Global Sync** — sync adiado por concorrência re-dispara sozinho, sem prender a clínica.
- **SyncJob dedup/lease** — deduplicação atômica de jobs e posse por lease.
- **Idempotência de breaks** — criação/movimentação de breaks sem duplicatas.
- **Retry 401 restrito a operações seguras** — repetição pós-reautenticação apenas onde não há risco de duplicação.
- **Timeout da integração VisMed**.
- **Observabilidade/baseline** — métricas por origem/endpoint como base de decisão.

---

## WPs/tasks estruturais concluídos (todos MERGED)

| Área | Tasks |
|---|---|
| Observabilidade/baseline | #64, #68, #71, #74, #79 |
| Request Coordinator (prioridade, backpressure, pacing LOW) | #142, #170 |
| Concorrência por clínica | #97, #105, #119, #122 |
| Global Sync (reserva de prioridade + stagger) | #133, #136 |
| GET dedup | #124 |
| Cache TTL | #126 |
| Retry/backoff/jitter + gate pós-OPEN | #127, #162 |
| Budgets GET/WRITE | #130 |
| Circuit breaker | #138 |
| Backpressure | #142 |
| Idempotência (breaks, retry 401 seguro, move de break) | #83, #84, #91 |
| QA retry 401 | #102 |
| OAuth single-flight | #157, #169 |
| Headroom ε | #155 |
| SyncJob dedup/lease | #111, #113, #115, #116, #117 |
| Harness/carga | #146, #150, #154, #159, #160 |
| Resiliência validada (F1–F3) | #161 |

---

## Capacidade validada

- Baseline levantado com harness seguro (sem tocar a Doctoralia real).
- **Cenário B / 10 clínicas** — validado.
- **Cenário C / 20 clínicas** — validado; **Cenário C pós-pacing: PASS**.
- Maior lacuna LOW com demanda pendente ≈ **6,8s**.
- Espera máxima LOW caiu de ≈ **60,1s** para ≈ **37,0s**.
- **Zero QueueTimeout** na validação pós-pacing.
- **Cenário D / 50 clínicas** deliberadamente **não executado** por não
  corresponder à capacidade operacional prevista — **decisão de escopo, não
  falha técnica**.

---

## Proteções em produção

- Teto agregado de chamadas à Doctoralia (400/5min);
- Budgets GET/WRITE;
- Headroom ε das sliding windows;
- Pacing LOW;
- Backpressure (caps + deadlines de fila);
- Circuit breaker;
- Bloqueio de retries após OPEN;
- Concorrência por clínica (guard com política SKIP);
- Stagger determinístico dos syncs;
- Reserva de prioridade do Global Sync;
- OAuth single-flight;
- Dedup de GETs;
- Cache TTL;
- Idempotência de escritas (breaks, retry 401 seguro).

---

## Riscos residuais aceitos

> Importante: **risco aceito ≠ bug conhecido ≠ bloqueio.**

- **F4 (WAF)** e **F5 (API lenta)** pendentes da bateria de resiliência WP-13.
- Verificações de produção no Portainer ainda por confirmar:
  #118, #132, #135, #137, #140, #144, #158, #167.
- Métricas de observabilidade **in-memory** — perdem-se em restart do servidor.
- **Cenário D** não provado empiricamente (aceito por escopo).

---

## Critérios de reabertura

Reabrir a frente somente se ocorrer ao menos um dos itens abaixo:

(a) **>20 clínicas ativas**, ou plano comercial para **>30 em 6 meses**;
(b) **429/405-WAF sustentado >1%** das chamadas em 24h;
(c) **circuit breaker OPEN >2×/semana** por saturação;
(d) **p95 da fila >30s** em operação normal;
(e) **alteração de limites ou política de autenticação** da Doctoralia;
(f) **qualquer duplicação de booking/break em produção**.

---

## Status final

🟢 **ROADMAP DE CONFIABILIDADE E ESCALABILIDADE DOCTORALIA/VISMED ENCERRADO**

Novas alterações nessa arquitetura devem ser orientadas por **evidência
operacional** ou pelos **critérios de reabertura** acima — não pela criação
preventiva de novos WPs.
