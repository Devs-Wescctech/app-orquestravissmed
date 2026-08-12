# Sumário de escalabilidade — WP-12B (perfil medium)

- Execução: 2026-08-12T20:32:55.381Z → 2026-08-12T20:41:46.700Z · seed `wp12b-scale`
- Ordem executada: B (PARADO em B: critérios pass/fail violados (violação estrutural))

| Cenário | Clínicas | Resultado | Tempo | Relatório |
|---|---|---|---|---|
| B | 10 | ❌ FAIL | 531.3s | scenario-b-medium-2026-08-12T20-41-46-275Z.json |
| C | 20 | ⏭️ NÃO EXECUTADO (regra de parada) | — | — |
| D | 50 | ⏭️ NÃO EXECUTADO (regra de parada) | — | — |

- **Cenário mais alto saudável:** nenhum
- **Primeiro gargalo observado:** Budget agregado 400/5min nunca excedido (mock Doctoralia); Budget WRITE 40/min nunca excedido; Zero escrita duplicada nos mocks (janela 120s)

## Crescimento vs. baseline A (fatores)
| Cenário | ×clínicas | ×duração | ×chamadas | ×memória | ×pico fila | ×espera p95 |
|---|---|---|---|---|---|---|
| B | ×5 | ×9.53 | ×4.98 | ×1.12 | ×— | ×— |

Detalhes por cenário (stagger, reservas, backpressure, cache/dedup) nos relatórios individuais listados acima.
