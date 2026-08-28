# Gate de compatibilidade — identidade de médico VisMed por empresa

## Decisão

**BLOQUEADO. Nenhuma migration ou alteração parcial foi aplicada.**

A identidade composta `(idEmpresaGestora, vismedId)` não pode ser introduzida
mantendo simultaneamente zero diff e o mesmo comportamento nos fluxos
congelados.

O modelo atual declara `VismedDoctor.vismedId` como único global. Ao remover
essa unicidade, o Prisma deixa de aceitar `where: { vismedId }` em
`findUnique` e `upsert`. Além da quebra de compilação, substituir essas
operações por uma busca não-única não preservaria o comportamento: quando duas
empresas tiverem o mesmo `idprofissional`, a escolha de um registro sem o
escopo da empresa será inerentemente ambígua.

Manter a unicidade global como camada de compatibilidade preservaria as
consultas atuais, mas impediria exatamente o estado requerido (por exemplo,
empresa 52/profissional 5867 e empresa 286/profissional 5867 com UUIDs
distintos). Portanto, isso não implementaria a identidade composta.

## Consultas incompatíveis em fluxos congelados

### Polling e fallback de agendamentos

Arquivo somente analisado, sem diff:
`apps/api/src/bookings/booking-sync.service.ts`

- O fallback de materialização faz `upsert` por `vismedId` global.
- A ingestão procura o médico com `findUnique` por `vismedId` global.
- Depois da remoção da unicidade global, o `upsert` não compila e a leitura não
  consegue determinar a empresa sem receber ou resolver
  `idEmpresaGestora`.

Esse arquivo pertence explicitamente ao escopo congelado e não pode ser
adaptado nesta tarefa.

### Block Watcher

Arquivo somente analisado, sem diff:
`apps/api/src/sync/block-watcher.service.ts`

- A ressincronização resolve o UUID interno com `findUnique` por
  `vismedId`.
- Outro caminho usa `findFirst` por `vismedId`; com homônimos entre empresas,
  ele pode escolher silenciosamente o médico errado.

Não existe informação suficiente no registro do médico para uma camada externa
corrigir uma escolha global sem alterar o contrato desse fluxo.

### Executor de breaks administrativos

Arquivo somente analisado, sem diff:
`apps/api/src/sync/admin-block-break-sync.service.ts`

- A resolução do médico e do vínculo Doctoralia usa `findUnique` por
  `vismedId`.
- Após a identidade composta, a consulta deixa de compilar; uma busca
  não-única poderia selecionar o vínculo Doctoralia de outra empresa.

### Sincronização de slots e `facilityId`

Arquivos somente analisados, sem diff:

- `apps/api/src/sync/slot-sync.service.ts`
- `apps/api/prisma/schema.prisma`

O `SlotSyncService` consulta `VismedDoctor` pelo UUID interno e, isoladamente,
essa leitura é compatível. Porém, os chamadores congelados que convertem
`idprofissional` em UUID usam a identidade global descrita acima.

`facilityId` pertence ao domínio Doctoralia e não é o escopo de catálogo do
`VismedDoctor`. Ele não substitui `idEmpresaGestora` e não oferece uma chave de
compatibilidade sem mudar contratos e comportamento.

## Escritores de catálogo que receberiam diff se o gate fosse aprovado

Uma implementação real exigiria alterações em:

- `apps/api/prisma/schema.prisma`
- uma nova migration fail-closed
- `apps/api/src/sync/vismed-sync/vismed-sync.processor.ts`
- `apps/api/src/sync/sync.service.ts`
- resolução/matching estritamente relacionado à empresa

Os dois Full Syncs poderiam fazer upsert pelo par empresa/profissional. Isso,
entretanto, não elimina a incompatibilidade dos leitores e do writer de
fallback congelados.

## Arquivos e componentes analisados sem alteração

- `apps/api/prisma/schema.prisma`
- `apps/api/prisma/migrations/20260817_specialty_empresa_scope/migration.sql`
- `apps/api/src/sync/vismed-sync/vismed-sync.processor.ts`
- `apps/api/src/sync/sync.service.ts`
- `apps/api/src/mappings/mappings.service.ts`
- `apps/api/src/mappings/matching-engine.service.ts`
- `apps/api/src/sync/block-watcher.service.ts`
- `apps/api/src/sync/admin-block-break-sync.service.ts`
- `apps/api/src/bookings/booking-sync.service.ts`
- `apps/api/src/sync/slot-sync.service.ts`
- `apps/api/src/sync/sync.controller.ts`
- testes de Full Sync, matching, polling, Block Watcher e breaks relacionados

Também foram classificados como seguros os leitores que já usam o UUID interno
de `VismedDoctor`, incluindo relações de `Mapping`,
`ProfessionalUnifiedMapping`, bookings e a leitura interna do Slot Sync.

`VismedUnit` e `VismedInsurance` não foram alterados.

## Menor alteração que exige aprovação separada

Para liberar a identidade composta é necessária uma mudança coordenada, com
aprovação explícita para adaptar os fluxos atualmente congelados:

1. Introduzir uma resolução compartilhada cujo contrato receba `clinicId` ou
   `idEmpresaGestora` junto com `idprofissional`.
2. Alterar polling/fallback de `BookingSyncService`, Block Watcher e executor de
   breaks para resolver o UUID interno pelo par empresa/profissional.
3. Só então remover a unicidade global, criar a unicidade composta e o índice
   parcial para legado sem empresa.
4. Executar o backfill fail-closed via
   `VismedDoctor UUID → Mapping(DOCTOR) → clinicId → IntegrationConnection
   Vissmed → idEmpresaGestora`, atualizando apenas convergência para uma única
   empresa.
5. Cobrir em regressão os fluxos operacionais alterados e o isolamento entre
   empresas.

Sem aprovação dos itens 1 e 2, qualquer migration que permita IDs duplicados
causaria quebra de compilação ou seleção operacionalmente incorreta. O critério
de parada da tarefa foi, portanto, acionado antes de qualquer mudança de
produção.