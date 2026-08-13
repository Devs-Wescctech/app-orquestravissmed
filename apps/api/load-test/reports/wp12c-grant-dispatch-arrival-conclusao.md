# WP-12C — Conclusão: grant × dispatch × arrival (Cenário B)

**Execução:** cenário B, perfil `medium`, 10 clínicas, seed `wp12b-scale`
**Relatório:** `scenario-b-medium-2026-08-12T22-24-48-381Z.{json,md}`
**Dumps brutos:** `...-internal-events.ndjson` (661 eventos da API com enqueuedAt/releasedAt/sentAt), `...-mock-arrivals.ndjson` (661 chegadas no mock com correlationId e timestamp de chegada), `...-correlated.ndjson` (661 pares casados com deltas).

## Correlação

661/661 requisições correlacionadas via header `x-loadtest-correlation-id` (inerte fora do harness — só é enviado com `LOADTEST_CORRELATION_HEADER=true` no env do processo filho). Zero eventos sem chegada, zero chegadas sem evento interno; Δ mock=baseline=0.

## Semânticas de fronteira — ponto central da análise

Existem DUAS definições de "janela deslizante" em jogo, e elas divergem exatamente na fronteira:

- **Inclusiva (auditoria do mock, `call-log.budgetAudit`)**: eviction quando `delta > janela` → dois eventos separados por EXATAMENTE 60.000ms contam na mesma janela.
- **Estrita (limiter produtivo, `docplanner.service.ts`)**: eviction `<= now - janela` / contagem `t > cutoff` → um evento exatamente 60.000ms mais velho já está FORA da janela.

Os máximos foram calculados nas duas semânticas (campos `max` e `maxStrict` no relatório):

| Série | WRITE/60s inclusiva | WRITE/60s estrita | Agregado/5min inclusiva | Agregado/5min estrita |
|---|---|---|---|---|
| grants | 42 | **40** | 401 | **400** |
| dispatches | 42 | **40** | 401 | **400** |
| arrivals | 42 | **42** | 401 | **401** |
| limite | 40 | 40 | 400 | 400 |

## Deltas por requisição

| Delta | min | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| grant→dispatch (todas, n=661) | 0ms | 0ms | 0ms | 0ms | 1ms |
| dispatch→arrival (todas, n=661) | 0ms | 1ms | 6ms | 15ms | 44ms |
| grant→dispatch (WRITE, n=176) | 0ms | 0ms | 0ms | 1ms | 1ms |
| dispatch→arrival (WRITE, n=176) | 0ms | 1ms | 12ms | 16ms | 44ms |

## Veredito sobre a hipótese da #151

**CONFIRMADA na formulação correta (semântica estrita): grants/dispatches ≤ limite enquanto arrivals excedem.**

- Pela DEFINIÇÃO DO PRÓPRIO LIMITER (estrita), os grants nunca passam do limite: pico de exatamente **40** WRITE/60s e **400** agregado/5min. O limiter é internamente consistente — não há bug de contabilidade "janela fixa"; a eviction é por janela móvel.
- Mesmo assim, as CHEGADAS violam o limite em janela estrita REAL: **42 WRITEs em 59.995ms** (22:21:02.327 → 22:22:02.322) e **401 chamadas em 299.961ms**. As requisições dessas janelas ofensoras estão listadas no JSON (`grantDispatchArrival.*.strictRequests`).

**Mecanismo do estouro (dois fatores que se somam na fronteira):**

1. **Zero headroom na fronteira**: quando a janela está cheia, o limiter libera o próximo WRITE no instante em que o mais antigo completa exatamente 60.000ms — os bursts ficam espaçados por EXATAMENTE a janela (o pico inclusivo de grants, 42, contém extremos separados por 60.000ms cravados; padrão de rajadas de 13 e 29 WRITEs em fronteiras consecutivas).
2. **Jitter de transporte comprime a fronteira**: com espaçamento exato de 60.000ms no grant, qualquer diferencial de latência positivo (medido: p99 = 16ms, máx = 44ms) faz as chegadas caírem DENTRO de uma janela real de <60s — foi exatamente o observado (59.995ms).

Adicionalmente, a **auditoria do mock usa semântica inclusiva**, que conta o par exatamente-na-fronteira mesmo sem jitter — parte do "42/40" reportado pelo harness nos relatórios anteriores é essa divergência de semântica, não excesso real de grants. Recomenda-se declarar explicitamente qual semântica o contrato com a Doctoralia usa; na dúvida, tratar a inclusiva (mais conservadora) como oficial.

Nota: as 4 "duplicatas" desta execução são POSTs OAuth da mesma clínica com Δ 6–15ms (stampede de token — lacuna já mapeada na #152, fora do escopo; não são escritas de negócio).

## Recomendação de pacing WRITE (parecer — nada implementado nesta task)

1. **Headroom na fronteira do refill (correção mínima)**: quando a janela está cheia, aguardar `janela + ε` (e não exatamente `janela`) desde o evento mais antigo antes do próximo grant, com `ε` maior que o jitter observado e que a divergência de semântica — **ε = 250–500ms** é ordens de grandeza acima do máx medido (44ms) e custa <1% de throughput. Isso elimina simultaneamente a compressão por jitter E a discrepância inclusiva/estrita.
2. **Espaçamento de WRITEs dentro da janela (robustez)**: distribuir os grants WRITE com espaçamento mínimo ~**1.500ms** (60s ÷ 40, com pequena tolerância de burst, ex.: ≤5), em vez de rajadas de 13–29 na fronteira. Com grants espaçados, nenhum evento fica "cravado" na fronteira e o jitter de dezenas de ms se torna estatisticamente irrelevante.
3. **Safety margin no ORÇAMENTO (39/399) continua DESNECESSÁRIA**: o problema não é o tamanho do budget, é o instante do refill/espaçamento. Com o ε da recomendação 1 (ou o pacing da 2), a série de chegadas fica ≤40/60s e ≤400/5min em qualquer semântica, mantendo os budgets integrais 40/2.400/400.

## Restrições respeitadas

Nenhuma alteração na lógica do limiter produtivo, budgets intactos (40/2.400/400), sem pacing implementado, sem mudanças na #151/#152, sem push manual. Mudanças na API estritamente aditivas: header de correlação gateado por env do harness e endpoint de leitura `GET /metrics/doctoralia-baseline/raw-events` (SUPER_ADMIN) expondo o buffer de eventos já coletado. Análise coberta por testes (`load-test/tests/grant-dispatch.test.js`): fronteiras exatas de 60.000/300.000ms nas duas semânticas, correlação completa e parcial, e o cenário de compressão.
