# Contrato do boot e da migration controlada

## Causa raiz e limite da correção

O entrypoint anterior rodava `prisma db push` sob `set -e`. A adição do índice
único composto `IntegrationConnection(id, clinicId)` pode fazer esse comando
exigir autorização de perda de dados: sua saída não-zero interrompia o script
antes da API/Web. Isso **não prova que há dados duplicados**; `id` já deve ser PK.
Não se deve contornar a proteção com aceitação de perda de dados.

O histórico de 12 migrations pendentes no Portainer foi **relatado pelo
operador**, não consultado nesta implementação. Um banco mantido por `db push`
não pode ser tratado como banco novo nem receber replay indiscriminado do
histórico. Esta correção não faz baseline, resolve ou grava histórico Prisma.

A validação é restrita aos pré-requisitos e objetos abaixo; não é uma auditoria
de todo o datamodel. A API e os fluxos operacionais existentes não foram alterados.

## Pré-requisitos históricos, somente leitura

No schema exato de `DATABASE_URL` (`public` apenas quando o parâmetro `schema`
não existe):

- `Clinic`, `IntegrationConnection` e `DoctoraliaDoctor`: tabelas permanentes,
  PK não-deferrable em `id`, índice da PK válido/pronto.
- Os três `id` e `IntegrationConnection.clinicId`: `text NOT NULL`, sem
  identidade/expressão generated.
- FK histórica `IntegrationConnection.clinicId → Clinic.id`, no mesmo schema,
  validada, `MATCH SIMPLE`, não-deferrable, `ON DELETE/UPDATE CASCADE`.

Banco vazio, schema inexistente, PK ausente, tabela não permanente ou referência
para outro schema são baseline incompatível. Não há criação automática da base.

## Inventário autorizado

Tipos abreviados: **T** = `text`; **I** = `integer`; **TS** =
`timestamp(3) without time zone`. Toda coluna é `NOT NULL`, exceto as duas
explicitamente indicadas. Não há default SQL além dos listados; UUID e
`@updatedAt` são responsabilidade do cliente Prisma, não defaults do banco.

| Objeto | Colunas | PK / defaults SQL |
|---|---|---|
| `DoctoraliaCatalogGeneration` | `id:T`, `clinicId:T`, `connectionId:T`, `catalogScopeVersion:I`, `facilityCount:I`, `doctorCount:I`, `publishedAt:TS`, `expiresAt:TS` | PK `id`; `publishedAt=CURRENT_TIMESTAMP` |
| `DoctoraliaCatalogMember` | `id:T`, `generationId:T`, `facilityId:T`, `doctoraliaDoctorId:T`, `doctoraliaExternalId:T`, `createdAt:TS` | PK `id`; `createdAt=CURRENT_TIMESTAMP` |
| `DoctoraliaCatalogCredential` | `id:T`, `memberId:T`, `council:T`, `number:T`, `uf:T NULL`, `regional:T NULL`, `createdAt:TS` | PK `id`; `createdAt=CURRENT_TIMESTAMP` |
| `DoctoraliaCatalogLease` | `connectionId:T`, `clinicId:T`, `owner:T`, `expiresAt:TS`, `updatedAt:TS` | PK `connectionId`; sem defaults |
| `DoctoraliaCatalogAttemptBucket` | `bucketStart:TS`, `attempts:I`, `updatedAt:TS` | PK `bucketStart`; `attempts=0` |
| Coluna em `IntegrationConnection` | `catalogScopeVersion:I NOT NULL` | default `1` |
| Índice em `IntegrationConnection` | UNIQUE `(id, clinicId)` | `IntegrationConnection_id_clinicId_key` |

Índices adicionais, além das cinco PKs:

| Tabela | Chaves, na ordem exata |
|---|---|
| Generation | `(clinicId, connectionId, catalogScopeVersion, publishedAt)`; `(expiresAt)` |
| Member | UNIQUE `(generationId, facilityId, doctoraliaExternalId)`; `(generationId, doctoraliaDoctorId)` |
| Credential | UNIQUE `(memberId, council, number, uf, regional)`; `(council, number, uf, regional)`; `(memberId)` |
| Lease | `(clinicId, expiresAt)`; UNIQUE `(connectionId, clinicId)` |

Todos são B-tree, válidos/prontos, ASC com ordenação de nulos padrão, opclasses
padrão, sem predicado, expressão ou INCLUDE. A semântica é `NULLS DISTINCT`.
Os nomes exatos e o inventário executável estão em
`apps/api/scripts/task261/cli.js`, em correspondência ao SQL autorizado.

As sete FKs são validadas, não-deferrable, `MATCH SIMPLE`, no mesmo schema e
`ON UPDATE CASCADE`:

- Generation: `clinicId → Clinic.id`; `(connectionId, clinicId) →
  IntegrationConnection(id, clinicId)`, ambas `ON DELETE CASCADE`.
- Member: `generationId → Generation.id`, `ON DELETE CASCADE`;
  `doctoraliaDoctorId → DoctoraliaDoctor.id`, **ON DELETE RESTRICT**.
- Credential: `memberId → Member.id`, `ON DELETE CASCADE`.
- Lease: `clinicId → Clinic.id`; `(connectionId, clinicId) →
  IntegrationConnection(id, clinicId)`, ambas `ON DELETE CASCADE`.

## Estados e códigos de saída

| Código | Estado | Ação |
|---:|---|---|
| 0 | `applied` | Contrato completo; preflight e reaplicação não fazem DDL. |
| 20 | `absent` | Baseline compatível e nenhum objeto novo. Boot bloqueado sem opt-in. |
| 21 | `partial` | Algum objeto existe, mas o contrato está incompleto/divergente. Não reparar automaticamente. |
| 22 | `baseline_incompatible` | Pré-requisitos históricos ausentes/divergentes. Não executar SQL. |
| 23 | configuração | Falta/invalidade de URL, comando inválido ou migration sem `true` exato. |
| 24 | operação falhou | Conexão, permissão, timeout, integridade do SQL ou transação falhou. Serviços não iniciam. |

O preflight abre `BEGIN READ ONLY` e consulta catálogos PostgreSQL. Não lê
registros de pacientes nem o histórico Prisma. Os relatórios usam somente
identificadores estruturais conhecidos, nunca valores/defaults brutos do banco,
URLs ou mensagens brutas de erro.

O runner recebe apenas o comando fixo `migrate`, exige o opt-in internamente,
obtém advisory lock transacional, reavalia o contrato após obter exclusão,
executa o arquivo SQL fixo validado por SHA-256 e revalida antes do commit.
Concorrentes deste runner se serializam; DDL externo não cooperativo deve ser
proibido durante a janela operacional.

Timeouts: conexão e lock de 10 segundos; statement do preflight de 10 segundos;
statement da migration de 60 segundos. O tempo ocioso dentro da transação
também é limitado. Falha antes do commit causa rollback de toda a migration.
Não há seleção arbitrária de arquivo nem escrita em `_prisma_migrations`.

## Operação e rollback

Os comandos completos, backup obrigatório, separação entre one-shot e boot,
remoção da flag e política de restart estão em [DEPLOY_PORTAINER.md](../../DEPLOY_PORTAINER.md#5-preflight-e-migration-controlada-da-task-261).

O rollback automático por falha antes do commit é diferente da reversão manual
de uma aplicação bem-sucedida: esta última remove tabelas e pode destruir dados.
Pare os leitores novos, preserve/exporte dados e prefira restauração de backup
validado. O `rollback.sql` também remove o índice composto e a coluna da conexão;
revise cada `DROP` e o schema de destino antes de autorizar qualquer execução.
O rollback **não** é um comando deste runner.

Não manter `APPLY_TASK261_MIGRATION=true` em serviços normais. A allowlist de
matching continua vazia. Nenhum desses comandos autoriza ativação de clínicas,
alteração dos fluxos congelados ou publicação de imagem.