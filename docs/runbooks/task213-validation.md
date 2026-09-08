# Entrega — boot seguro e migration controlada

Evidências obtidas em **2026-09-08**, exclusivamente em ambiente descartável.
Nenhum banco persistente, Portainer ou deployment Replit foi acessado.
Não houve push de imagem, publicação, deploy ou alteração de secrets.

## Resultado e causa raiz

O boot anterior executava `db push` sob `set -e`; o aviso de criação do índice
único composto podia interromper a inicialização exigindo uma autorização
destrutiva. A solução não aceita perda de dados nem tenta reproduzir o histórico
Prisma do banco legado. Os detalhes e o inventário estão no
[contrato estrutural](task261-controlled-schema.md).

Agora:

- Boot normal exige `DATABASE_URL` e preflight somente leitura.
- `APPLY_TASK261_MIGRATION=false` é o default da imagem. Só `true` exato permite
  o SQL fixo da migration `20260904_doctoralia_tenant_catalog`.
- Migration é uma transação, com lock, timeouts, revalidação e rollback integral.
- Parcial/incompatível bloqueia ambos os serviços sem correção automática.
- Aplicado é no-op, sem DDL. Nenhum histórico Prisma é gravado.
- Flags antigas não reativam seed, migrations antigas ou bypass.
- Matching continua desabilitado por padrão; nenhum fluxo congelado foi editado.
- A política versionada é `on-failure:3`, não `unless-stopped` para a aplicação.

Também foi removido o caminho de mutação automática de schema do script
pós-merge: deixá-lo ativo faria o merge executar exatamente as operações
proibidas pelo procedimento novo.

## Arquivos alterados

| Grupo | Arquivos |
|---|---|
| Boot e imagem | `docker-entrypoint.sh`, `Dockerfile`, `docker-compose.portainer.yml` |
| Runner e comandos | `apps/api/scripts/task261/cli.js`, `apps/api/package.json` |
| Testes descartáveis | `apps/api/scripts/task261-tests/integration.test.js`, `apps/api/scripts/task261-tests/generate-prior-datamodel.js`, `scripts/task261-docker-smoke.sh`, `scripts/test-api-isolated.sh` |
| Automação segura | `.replit`, `scripts/post-merge.sh` |
| Operação | `DEPLOY_PORTAINER.md`, `docs/runbooks/doctoralia-tenant-catalog-task261.md`, este relatório, o contrato estrutural e o diff abaixo |

O datamodel, o SQL da migration, o rollback SQL e os fontes API/Web permaneceram
inalterados. `pg` já era dependência de produção; não foi preciso adicionar pacote.
O `.dockerignore` existente foi verificado pelo build real: runner e SQL estão
presentes na imagem após prune.

**Diff completo do entrypoint:** [task213-entrypoint.diff](evidence/task213-entrypoint.diff)
(gerado com `git diff --unified=0`; não é comando operacional para aplicar schema).

## Testes e resultados

| Verificação | Resultado real |
|---|---|
| Prisma validate | Sucesso, com URL sintética; sem conexão a banco persistente |
| Build API | Sucesso |
| Build frontend | Sucesso, com avisos preexistentes descritos abaixo |
| Segurança do runner, PostgreSQL 16 local descartável | **32/32 testes passaram** |
| Regressões selecionadas da aplicação | **20 suítes, 509 testes passaram** |
| Bash/JavaScript syntax, Compose config e `git diff --check` | Sucesso |
| Build Docker multi-stage completo | Sucesso, imagem local `vismed-task213:local` |
| Smoke da imagem real com PostgreSQL 16/Redis descartáveis | Sucesso pela rede interna Docker |
| Captura de tela pelo host | **Bloqueada** por `ERR_CONNECTION_REFUSED` na porta publicada; não apresentada como validação visual concluída |

As 20 suítes incluem catálogo, matching tenant-safe/CRM, token refresher,
integração de módulos, retry 401, BookingSync/ingestion/feed/rebind/break dedup,
Safety Sweep, polling, guards de concorrência, sincronização global, status,
empresa, claim, dedup/lease e timeout da fila.

A rodada inicial da fila falhou porque foi deliberadamente usada uma URL
sintética sem servidor. A suíte foi então executada com sucesso em PostgreSQL
descartável real. Isso não foi tratado como falha preexistente da aplicação nem
como aprovação com teste ignorado.

Os testes novos e o smoke verificam:

- Ausente/aplicado/parcial/baseline incompatível; flags estritas inclusive em
  banco já aplicado; configuração ausente/inválida.
- Colunas, defaults, índices, FKs não validadas, referência a outro schema,
  identidade/generated, `NULLS NOT DISTINCT`, colisões de nomes e `UNLOGGED`.
- Schema não público; rejeição de parâmetro `schema` vazio ou duplicado.
- Dois migradores concorrentes; segunda execução sem DDL, verificada por
  event trigger do PostgreSQL.
- Falha injetada pelo PostgreSQL no meio do SQL, com rollback de todas as
  alterações; histórico e sentinela preservados.
- SQL adulterado em cópia isolada do runner, sem alterar o arquivo autorizado;
  erros não vazam credenciais/URL.

## Evidência da imagem real

Imagem construída localmente:

```text
vismed-task213:local
sha256:c590e5595f77dd54b3a42917e6553a82efec8f3c7b2b2b41fd0197adfc5acad4
```

O smoke compara o hash do runner e do entrypoint na imagem com os fontes atuais.
O runner verifica o SHA-256 do SQL autorizado antes da execução. A última
rodada reutilizou essa imagem já construída depois de ajustes apenas no harness
de teste; nenhum arquivo de produção foi substituído na imagem.

Foram exercitados os modos `preflight-task261`, `migrate-task261`, boot normal
com schema aplicado e boot opt-in sobre baseline anterior. Ausência de URL,
baseline vazio, flags legadas, schema divergente e `UNLOGGED` foram rejeitados.
O one-shot não iniciou serviços. A aplicação recebeu apenas configuração
sintética e allowlist vazia, sem herdar URLs/credenciais da sessão.

Trechos da rodada final, encerrada com código **0**:

```text
[task261] schema state: applied
[task261] no DDL was required; remove APPLY_TASK261_MIGRATION from the environment before normal boot.
must survive byte-for-byte:baseline_history_must_not_change
Hello World!
Normal applied boot made no DDL (PostgreSQL event-trigger audit)
SIGTERM shutdown completed cleanly
PASS: all Task 261 Docker smoke assertions passed.
```

O Web respondeu HTTP com HTML real e a API respondeu `Hello World!`, consultados
por containers clientes na mesma rede interna. O encerramento por SIGTERM
também exigiu exit code `0`. O PostgreSQL e o Redis usaram tmpfs; os containers
temporários e sua rede foram removidos após as verificações.

## Limitações e tentativas corrigidas

- Neste ambiente, `docker exec` falhou por erro OCI/setns. O harness passou a
  usar novos containers clientes, sem relaxar o isolamento da rede.
- A porta publicada no host não ficou acessível, apesar de os serviços
  responderem dentro do Docker. A tentativa de screenshot também retornou
  `ERR_CONNECTION_REFUSED`; **não há evidência visual nem validação de
  publicação/rede do Portainer** nesta entrega.
- Um smoke intermediário omitiu a chave JWT sintética exigida pela API. O
  entrypoint encerrou com código 1 e derrubou o outro processo. O harness foi
  corrigido, sem mudar a autenticação da aplicação; a rodada final passou.
- O frontend já exibia aviso de patch do lockfile SWC (`reading 'os'`) e
  Browserslist desatualizado. O build terminou com exit code 0; não foram
  alterados lockfile, versões ou configurações para mascarar esses avisos.
- Não foi executada a suíte global irrestrita da aplicação, nem foi feito teste
  de carga em banco grande ou qualquer validação sobre dados reais.

## Reproduzir e operar

Testes locais, sem URLs persistentes:

```bash
node --test apps/api/scripts/task261-tests/integration.test.js
bash scripts/test-api-isolated.sh src/bookings/queue.service.dedup-lease.spec.ts
bash scripts/task261-docker-smoke.sh
```

O último comando constrói a imagem por padrão e remove seus recursos
descartáveis ao terminar. `--hold-preview` é apenas uma conveniência de teste;
se usado, seus recursos devem ser removidos pelos nomes impressos no log.

**Operação autorizada, após parar a versão antiga e validar um backup
restaurável** (não executada contra Portainer nesta tarefa):

```bash
docker compose -f docker-compose.portainer.yml run --rm --no-deps \
  vismed preflight-task261

docker compose -f docker-compose.portainer.yml run --rm --no-deps \
  -e APPLY_TASK261_MIGRATION=true vismed migrate-task261
```

Remova a flag da configuração após sucesso. Faça o boot normal sem opt-in;
aplique explicitamente a política de restart documentada aos containers
existentes, pois trocar o script não altera a política antiga.

**Rollback:** falhas antes do commit revertem automaticamente. Após commit,
reverta primeiro a versão leitora e preserve dados; prefira restaurar o backup.
O `rollback.sql` remove cinco tabelas, a coluna e o índice composto. Ele não é
executado pelo runner e exige revisão explícita do schema alvo e da perda de
dados. Não usar replay/resolve do histórico como reparo.