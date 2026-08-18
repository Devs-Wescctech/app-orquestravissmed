# Task 206 — Escopo do catálogo VisMed por empresa gestora — Relatório de validação

Data: 2026-08-17

## Decisão de escopo (conforme plano, sem desvio)
Chave: `idEmpresaGestora` (Int, = `IntegrationConnection.clientId`). Unique de
`VismedSpecialty` trocado de `vismedId` global para o composto `(idEmpresaGestora, vismedId)`,
com índice parcial único em `vismedId` para registros legados ainda sem escopo (NULL).
`VismedProfessionalSpecialty` e `SpecialtyServiceMapping` herdam o escopo via FK da
especialidade — nenhuma coluna extra necessária.

## Verificação do caso concreto (passo 9) — consulta à API VisMed ao vivo
`especialidades-by-idempresagestora` consultada em 2026-08-17:

| Empresa gestora | Clínica | Fonoaudiologia (`idcategoriaservico`) |
|---|---|---|
| **52** | Docctor Med Petrópolis | **3484** (catálogo na faixa 3xxx, 75 categorias) |
| **4** | Docctor Med São Leopoldo | **192** (catálogo na faixa 1xx, 69 categorias; há também 1607 "Fonoaudiologia - Exames") |

→ Booking Doctoralia 228750781 (clínica Petrópolis, empresa 52) foi criado com categoria
**192, que pertence à empresa 4** — o valor correto era **3484**. Confirmado.
Nenhuma correção retroativa feita (fora de escopo).

Os catálogos das duas empresas são **disjuntos** (nenhum `idcategoriaservico` em comum),
o que torna seguro o "claim" de registros legados sem escopo pelo `vismedId`.

## Migração de dados (fail-closed)
- Migration `20260817_specialty_empresa_scope`: coluna nova + unique composto + backfill
  SQL que atribui empresa APENAS quando todos os médicos vinculados à especialidade
  (via `Mapping` → `IntegrationConnection.clientId`) pertencem a UMA única empresa.
- Casos ambíguos ficam `NULL` e são reivindicados pelo sync escopado via `vismedId`
  (evento `specialty_claimed` no `SyncEvent`) — nunca por similaridade de nome.

## Snapshot pré vs pós (banco de desenvolvimento)
| Métrica | Pré | Pós |
|---|---|---|
| Especialidades | 71 | 71 (24 escopadas p/ 286, 47 NULL aguardando claim) |
| Vínculos médico↔especialidade | 37 | 37 (nenhum apagado) |
| Mappings serviço↔especialidade | 77 | 77 (nenhum apagado) |
| Vínculos cruzados entre empresas | — | **0** |
| Duplicatas (empresa, vismedId) | — | **0** |
| Homônimas | "clinico geral" {24103, 24119} | idem (coexistindo, intocadas) |

Arquivos: `reports/task206-pre-migration.txt`, `reports/task206-post-migration.txt`,
catálogos capturados em `reports/empresa_52.json`, `reports/empresa_4.json`.

## Mudanças de comportamento
1. **Syncs escopados** (processor + caminho direto do SyncService): upsert, homônimas,
   fantasmas, stale-link cleanup e `migrateObsoleteSpecialties` operam SOMENTE dentro do
   `idEmpresaGestora` da conexão em execução. Registros de outra empresa nunca são tocados.
2. **Guarda no agendamento** (`buildVismedCreatePayload`): categoria escolhida deve
   pertencer à mesma empresa enviada em `idempresagestora`; divergência bloqueia o POST
   com erro explícito (booking FAILED). Fluxo reverso VisMed→Doctoralia idem.
3. **Consumidores**: availability (`getClinicCategoryIds`), slot-sync e block-watcher
   filtram categorias pela empresa da clínica; dedup da UI de mappings não funde
   homônimas de empresas diferentes.

## Testes
- `vismed-sync.empresa-scope.spec.ts`: coexistência 192/3484, idempotência 52→4→52→4
  (zero migrações após estabilização), claim de legado, obsoletos só no próprio escopo.
- `booking-sync.empresa-guard.spec.ts`: guarda bloqueia divergência; fallback ignora
  vínculo cruzado remanescente; erro claro sem categoria da empresa.
- Suíte `src/sync` + `src/bookings` + `src/mappings`: 440 testes passando.
  (Falhas pré-existentes conhecidas em auth/users — task #66 — não relacionadas.)

## Produção (Portainer)
A migration + primeiro ciclo de sync de cada clínica estabilizam o catálogo:
cada empresa reivindica seus códigos, e `SyncEvent` deve parar de registrar
`specialty_migrated` em ping-pongue. Verificar no console do container após deploy.
