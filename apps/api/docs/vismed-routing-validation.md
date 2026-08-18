# VisMed Full Sync — Roteamento por Clínica: Pré-requisitos e Plano de Validação

## Contexto

A Fase 1 (Task 216) corrigiu o roteamento do Full Sync VisMed: a `baseUrl` e o `idEmpresaGestora`
agora são sempre lidos da `IntegrationConnection` da clínica (campo `domain` → baseUrl,
campo `clientId` → idEmpresaGestora), com comportamento **fail-closed** idêntico no processor
via fila e no caminho direto (fallback sem Redis).

---

## Pré-requisitos operacionais (executar manualmente no Portainer — FORA do deploy de código)

### 1. Corrigir o `domain` de Petrópolis

A clínica de Petrópolis estava configurada com `domain = api-vissmed-7` (instância global/incorreta).
O valor correto é `https://app.vissmed.com.br/api-docctor-3`.

**Ação:** no Portainer, atualizar a linha `IntegrationConnection` da clínica de Petrópolis:

```sql
UPDATE "IntegrationConnection"
SET domain = 'https://app.vissmed.com.br/api-docctor-3'
WHERE "clinicId" = '<id-da-clinica-petropolis>'
  AND provider = 'vismed';
```

> ⚠️ Não hardcodear `api-docctor-3` em código. A fonte de verdade é a configuração da clínica.

### 2. Obter a pasta correta para São Leopoldo

A instância atual configurada para São Leopoldo (`api-vissmed-5`) retorna 404.
**Ação pendente:** contatar a VisMed para confirmar qual pasta (`api-vissmedX`) está ativa
para a empresa gestora de São Leopoldo, e atualizar o `domain` na `IntegrationConnection`.

---

## Plano de validação piloto — Petrópolis (executar após pré-requisito 1)

### Objetivo
Confirmar que o Full Sync da clínica de Petrópolis usa a instância correta (`api-docctor-3`)
e retorna dados coerentes — sem 404, sem erro de parsing, sem impacto em mappings existentes.

### Passos

1. **Disparar SOMENTE o Full Sync de Petrópolis** (não o Global Sync de todas as clínicas)
   via admin ou diretamente na fila, garantindo `clinicId` = Petrópolis.

2. **Verificar os logs do SyncRun:**
   - Linha `[VISMED-ROUTING]` deve mostrar `host=app.vissmed.com.br` com path `/api-docctor-3`.
   - Sem mensagem de erro `Conexão VisMed não encontrada` nem `domain ausente`.

3. **Conferir o baseline de catálogo retornado** (números são baseline, não asserts rígidos):
   - Unidades: ~1 unidade
   - Especialidades: ~83 especialidades
   - Profissionais: ~1 profissional (Dra. Maria Lucia Hoeltz Antonio)
   - Convênios: ~15 convênios

4. **Confirmar ausência de efeitos colaterais:**
   - Nenhum médico existente foi desativado ou removido.
   - Nenhum mapping/agendamento existente foi alterado.
   - Nenhum erro de parsing nos logs.

5. **Verificar o status do SyncRun no banco:**
   ```sql
   SELECT status, "totalRecords", "endedAt", metrics
   FROM "SyncRun"
   WHERE "clinicId" = '<id-petropolis>'
     AND type = 'vismed-full'
   ORDER BY "createdAt" DESC
   LIMIT 1;
   ```
   Esperado: `status = 'completed'`.

---

## Rollback

- **Código:** reverter o commit desta task (volta ao roteamento anterior com fallback global).
  O banco não precisa ser alterado — o comportamento antigo ignorava o `domain` da conexão.
- **Configuração:** restaurar o `domain` anterior de Petrópolis para `api-vissmed-7` SOMENTE
  se houver evidência de que `api-docctor-3` está incorreto para a clínica.
  Não reverter a configuração sem evidência — o valor anterior era o bug.

---

## Resumo das mudanças de código (Fase 1)

| Caminho | Antes | Depois |
|---|---|---|
| Processor (fila) | baseUrl = global `api-vissmed-7` | baseUrl = `domain` da `IntegrationConnection` da clínica |
| Caminho direto (sem Redis) | baseUrl = `conn?.domain \|\| undefined` (permissivo) | baseUrl = resolver fail-closed |
| idEmpresaGestora no direto | fallback para empresa 286 | fail-closed: ausência de clientId → SyncRun failed |
| Divergência job vs. conexão | silenciosa | SyncRun failed com log observável |
