# Sumário de escalabilidade — WP-12B (perfil medium)

- Execução: 2026-08-12T20:28:09.368Z → 2026-08-12T20:32:29.580Z · seed `wp12b-scale`
- Ordem executada: B (PARADO em B: erro do harness / interrupção)

| Cenário | Clínicas | Resultado | Tempo | Relatório |
|---|---|---|---|---|
| B | 10 | ❌ FAIL | 260.2s | scenario-b-medium-2026-08-12T20-32-29-339Z-PARTIAL.json |
| C | 20 | ⏭️ NÃO EXECUTADO (regra de parada) | — | — |
| D | 50 | ⏭️ NÃO EXECUTADO (regra de parada) | — | — |

- **Cenário mais alto saudável:** nenhum
- **Primeiro gargalo observado:** Budget WRITE 40/min nunca excedido; Filas HIGH/LOW retornam a 0 ao final (dado ausente reprova); Toda clínica completa full+vismed-full em 2 janela(s) (0 failed, 0 preso); API encerra limpa (SIGTERM, sem Promise/timer órfão segurando o processo)

## Crescimento vs. baseline A (fatores)
| Cenário | ×clínicas | ×duração | ×chamadas | ×memória | ×pico fila | ×espera p95 |
|---|---|---|---|---|---|---|
| B | ×5 | ×4.65 | ×3.01 | ×1.04 | ×— | ×— |

Detalhes por cenário (stagger, reservas, backpressure, cache/dedup) nos relatórios individuais listados acima.
