# Task 261 — catálogo Doctoralia tenant-safe

## Fonte de autoridade

`DoctoraliaCatalogGeneration` fixa `clinicId`, `connectionId`,
`catalogScopeVersion`, publicação e expiração. `DoctoraliaCatalogMember` fixa,
para aquela geração, `facilityId`, o UUID local e o ID externo do médico. O
campo histórico `DoctoraliaDoctor.doctoraliaFacilityId`, PUM, BookingSync,
nomes e endereços **não** autorizam uma decisão.

A geração só é inserida depois de todas as páginas reais de facilities e
doctors terminarem. A publicação e os membros são uma transação serializável.
Falha, página inválida, ciclo, estouro de budget, conexão múltipla ou mudança
de versão não publicam nada. A validade é de 30 minutos. Não há leitura de
cache nesse fetch e cache hit em outros fluxos não renova a geração. Strings
brutas de registro são analisadas somente em memória; cada membro guarda apenas
linhas normalizadas por credencial (`council`, `number`, `uf`, `regional`). O
matching consulta exclusivamente essas credenciais indexadas.

Identidade forte exige escopo completo nos dois lados: CRM e demais conselhos
estaduais suportados exigem UF; CRN exige regional numérico e não usa UF. RQE é
somente evidência auxiliar e nunca substitui UF/regional. CFM e outros conselhos
federais/desconhecidos não possuem regra de auto-link neste rollout e falham
fechado até existir regra explícita revisada.

Após cada publicação bem-sucedida, a mesma transação remove gerações cujo
`expiresAt` terminou há mais de 24 horas. Gerações atuais/não expiradas e as
expiradas nas últimas 24 horas ficam disponíveis para auditoria; `ON DELETE
CASCADE` limita também members e credentials. Falha antes/durante a publicação
faz rollback e não executa pruning nem substitui a geração anterior. A retenção
é um default fixo e limitado, sem override inseguro por ambiente.

Todas as páginas usam `DocplannerClient.request(GET)`, portanto passam pela
fila/rate limit global existente. O produtor distribui no máximo 40 páginas
lógicas entre as clínicas selecionadas. Além disso, cada tentativa HTTP GET
real é admitida por um bucket persistido e atômico de 40 por janela de 15
minutos; retries e repetição após 401 também consomem o bucket.

O produtor catalog-only é iniciado de forma concorrente pelo cron já existente
de `TokenRefresherService` (`*/15`), sem cron ou timers próprios e sem entrar nos
caminhos booking/push/poll. A allowlist é resolvida antes de qualquer leitura de
credencial ou I/O Doctoralia; vazia significa zero I/O. Em cada ciclo são
selecionadas por rotação determinística no máximo 20 clínicas. O orçamento
lógico por clínica é `floor(40/N)` e cada tentativa HTTP real (incluindo retries
e repetição de 401) consome atomicamente o bucket DB compartilhado de 40 por
janela de 15 minutos. OAuth POST não consome esse bucket. Buckets com mais de
48h são podados antes de qualquer I/O externo.

Uma lease persistida por conexão (`DoctoraliaCatalogLease`) garante exclusão
entre réplicas, com owner e expiração calculada pelo relógio do PostgreSQL.
Ownership/deadline são verificados entre GETs. A publicação serializável bloqueia
a linha da lease com `FOR UPDATE` e revalida owner/expiração imediatamente antes
de criar a geração; perda de lease, deadline ou budget aborta sem renovar a
geração.

`IntegrationConnection(id, clinicId)` é único e as FKs compostas de generation
e lease exigem que `connectionId` pertença ao mesmo `clinicId`; a relação
simples com Clinic permanece para cascade. A evidência executável em PostgreSQL
descartável é `docs/runbooks/sql/task261-tenant-fk-evidence.sql`.

## Mudança de decisão

Antes, CRM e nomes consultavam tabelas Doctoralia globais e podiam criar PUM.
Para clínicas explicitamente habilitadas, o novo caminho:

1. recebe o `clinicId` do contexto VissMed;
2. exige exatamente uma conexão VissMed e uma Doctoralia, ambas com status
   exatamente `connected`, e revalida essas condições na transação de criação;
3. exige geração fresca na versão corrente;
4. usa somente membros dessa geração e o parser conservador;
5. exige identidade forte única (conselho, número, UF e regional CRN);
6. preserva LINKED coerente e bloqueia LINKED divergente, UNLINKED, múltiplos
   mappings e corrida; somente mapping ausente pode ser criado.

`LICENSE_NORMALIZER_SHADOW` continua apenas observacional. A ativação usa
`DOCTORALIA_TENANT_SAFE_DOCTOR_MATCH_CLINIC_IDS`, lista CSV vazia por padrão.
Não há valor padrão no código nem em arquivo de ambiente.

## Aplicação e rollback (não executar como parte da Task 261)

Dry-run de schema:

```sh
cd apps/api
npx prisma validate
npx prisma migrate diff --from-url "$DATABASE_URL" \
  --to-schema-datamodel prisma/schema.prisma --script
```

Aplicar somente em janela aprovada:

```sh
npx prisma migrate deploy
```

Rollback manual: remover primeiro a versão do aplicativo que lê o catálogo e
executar `apps/api/prisma/migrations/20260904_doctoralia_tenant_catalog/rollback.sql`.
Isso remove as cinco tabelas novas (`DoctoraliaCatalogAttemptBucket`,
`DoctoraliaCatalogLease`, `DoctoraliaCatalogCredential`,
`DoctoraliaCatalogMember`, `DoctoraliaCatalogGeneration`) e
`catalogScopeVersion`.

## Canário

1. Manter a allowlist vazia durante migration/deploy.
2. Rodar `docs/runbooks/sql/task261-catalog-dry-run.sql` e arquivar a saída.
3. Adicionar **um** `clinicId` à allowlist e reiniciar conforme o procedimento
   normal de configuração. Confirmar que `DISABLE_TOKEN_REFRESHER` não está
   ativo.
4. Aguardar o produtor catalog-only no cron existente de 15 minutos do
   `TokenRefresherService` e confirmar, para a clínica candidata, uma geração
   fresca com contagens e versão iguais à conexão.
5. Fotografar, antes do teste, todos os mappings `DOCTOR` do par
   `clinicId + VismedDoctor.id` e confirmar que o médico escolhido tem mapping
   ausente, registro forte completo e exatamente um candidato na geração fresca.
6. Disparar o fluxo real VissMed → Doctoralia já existente para esse médico.
   Confirmar que foi criado um único `LINKED` para o candidato fotografado e que
   nenhum PUM, nome, endereço, facility histórica ou BookingSync participou da
   decisão.
7. Repetir com um caso manual (`UNLINKED` ou `LINKED`) somente em ambiente de
   teste e confirmar que o mapping permaneceu byte a byte inalterado. Confirmar
   também que o matching não fez GET Doctoralia: as únicas leituras externas
   pertencem ao produtor catalog-only anterior.
8. Para desativar, esvaziar/remover a allowlist. Não apagar mappings.

Os sete casos PUM-only permanecem somente no relatório/dry-run
`audit-pum-only-doctor-mappings.sql`; qualquer remediação exige aprovação
separada. Nenhum resultado de banco é afirmado por este documento.

## Evidência local da implementação

Executado em 2026-09-04:

- `npx prisma validate --schema prisma/schema.prisma`: sucesso.
- `npm run build`: sucesso.
- specs focadas de catálogo, matching tenant-safe, CRM-RJ/CRN, retry HTTP,
  integração do cron, wiring Nest e compatibilidade VissMed: 7 suites,
  100 testes, sucesso.
- regressão operacional de BookingSync, Safety Sweep, polling, guards de
  concorrência e Global Sync: 9 suites, 322 testes, sucesso.
- suíte completa da API: 54 suites passaram, 1 foi ignorada e 5 falharam;
  1.066 testes passaram, 10 foram ignorados e 5 falharam. Quatro falhas são
  fixtures legadas de `auth/users` que não registram suas dependências
  (`UsersService`, `AuthService`, `PrismaService` e `JwtService`), já presentes
  antes desta mudança. O quinto erro ocorreu no smoke de
  `queue.service.dedup-lease.spec.ts` durante o run completo; os arquivos da
  fila estão fora do diff e a mesma suite, reexecutada isoladamente, passou com
  28/28 testes. Nenhuma suíte da Task 261 falhou.
- bootstrap real do Nest completou a resolução de `IntegrationsModule`,
  `MappingsModule`, `TokenRefresherService` e `DoctoraliaCatalogService`, sem
  ciclo ou provider ausente.
- `git diff --check`: sucesso; os arquivos do scheduler da Global Sync são
  idênticos ao estado anterior à correção.
- o schema foi reconstruído a partir do commit anterior à tarefa: ignorando os
  cinco espaços finais históricos removidos para manter `git diff --check`
  verde, o diff contém somente 79 linhas funcionais novas e nenhuma remoção.

Em PostgreSQL 16 descartável e local, sem acessar banco persistente:

- toda a cadeia anterior aplicou; depois de reconciliadas as lacunas históricas
  ao datamodel exato anterior à tarefa, a migration renomeada
  `20260904_doctoralia_tenant_catalog` aplicou e `prisma migrate diff` retornou
  `No difference detected`;
- `DoctoraliaCatalogMember` foi criado sem coluna `licenseNumbers`;
- as FKs compostas rejeitaram tanto uma geração quanto uma lease que tentavam
  combinar a conexão de uma clínica com o `clinicId` de outra;
- duas sessões concorrentes disputando a mesma lease produziram uma única
  vencedora;
- expiração, takeover e cleanup condicionado a owner funcionaram;
- `FOR UPDATE` impediu takeover durante a transação de publicação;
- 50 sessões concorrentes no bucket admitiram exatamente 40 tentativas e
  persistiram `attempts = 40`;
- o rollback removeu somente as cinco tabelas e a coluna novas, preservando o
  conjunto anterior de tabelas e uma linha sentinela.

Esses resultados são somente de build/teste local. Nenhuma migration foi
aplicada em banco persistente e nenhum estado ou dado de produção foi validado.
