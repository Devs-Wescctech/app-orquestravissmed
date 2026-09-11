# Ajustes da sincronização Doctoralia — 11/09/2026

Base revisada: `f88bb85f0b1a6bafa7ac740944eaa75f6d8b2379` (origin/main).
Branch: `codex/sync-catalogos-pendencias`. Implementação local; não publicada.

## Diagnóstico e comportamento

A execução observada de Petrópolis em 11/09/2026 às 13:09 BRT somou 13.583: 10.730 serviços globais, 2.728 convênios globais, 62 profissionais contados duas vezes e um estabelecimento. Isso não representa 13.583 agendamentos ou alterações. A duração observada foi 8m24s; não é uma medição do código novo.

1. As novas execuções completas Doctoralia, tanto via fila quanto fallback direto, têm `metrics.report.version = 2`: categorias, verificados/criados/alterados/inalterados/erros, duração das etapas e eventos de agenda separados. Um profissional aparece uma vez na categoria, mesmo encontrado em vários endereços. Registros compartilhados podem aparecer em categorias distintas (catálogo global e uso da clínica). O total mede verificações por categoria, não pessoas únicas nem chamadas HTTP. Ocorrências parciais produzem `completed_with_warnings`; histórico anterior e rotina VisMed mantêm a contagem antiga identificada na tela.
2. Catálogos globais usam checkpoints bem-sucedidos persistidos em SyncEvent, com prazo de 12 horas e escopo de clínica/conexão/domínio/clientId/versão. Ciclos dentro do prazo dispensam busca e escrita desses catálogos. Quando vencem, somente campos de negócio diferentes causam upsert. Falha, resposta vazia, inválida ou incompleta não avança o checkpoint. Atualização manual força nova leitura; pedido adiado permanece pendente até atendimento por uma execução da clínica. Endereços com rua literalmente igual após trim dispensam PATCH. Formatos diferentes continuam enviados.
3. Remoção de horários envia faixas conhecidas com `address_services: []`, nunca `slots: []`. Exige foto de origem completa e intervalos previamente gerenciados no mesmo escopo e janela. Convênio com plano único válido recebe esse plano; múltiplos planos exigem seleção no endereço da Doctoralia. Planos manuais existentes são preservados. Os slots usam os planos efetivamente vinculados ao endereço, pelo campo `insurance_plan_id`. Pendências e falhas de confirmação ficam visíveis.

A periodicidade de 30 minutos da atualização operacional de agenda foi preservada. Rotinas de consultas/agendamentos (bookings, polling, safety sweep e callbacks) não foram alteradas. O ganho esperado está na redução do reprocessamento dos catálogos; a nova duração precisa ser medida após publicação.

## Contrato HTTP

Rotas relativas ao prefixo global da API. Todas continuam protegidas por JWT e acesso à clínica (ou SUPER_ADMIN). Não há alteração em autenticação, paginação ou rate limit.

| Método e rota | Entrada | Resposta e comportamento |
| --- | --- | --- |
| POST `/sync/:clinicId/run` | `clinicId`; sem body | 201, objeto SyncRun com `id`, `status`, `type`, datas etc. Solicita atualização de catálogos. Fila pausada mantém resposta `{ "id": null, "status": "rejected", "reason": "Queue is paused" }`. |
| POST `/sync/:clinicId/global` | `clinicId`; body opcional `{ "idEmpresaGestora": 123 }`, que deve coincidir com a conexão VisMed | 201, `{ "vismedRunId": "...", "doctoraliaRunId": "..." }`. Doctoralia solicita atualização de catálogos. IDs podem ser nulos se a fila está pausada. |
| GET `/sync/:clinicId/history` | `clinicId`; sem query/body | 200, últimas 20 execuções, mais recentes primeiro, com eventos; nova propriedade opcional `metrics.report`. |
| GET `/sync/:clinicId/status` | `clinicId`; sem query/body | 200, estrutura anterior; `recentRuns` pode conter relatório novo e `completed_with_warnings`. `overallHealth` sinaliza warning; avisos não entram no numerador de sucesso integral. |

401 sem autenticação válida; 403 sem acesso à clínica. Falhas de execução assíncrona são registradas no SyncRun, não representam conclusão na resposta de disparo. Não há garantia de novo catálogo no instante do POST. A rota legada de teste e os disparos automáticos seguem o prazo normal.

Exemplo parcial de execução nova:

```json
{
  "status": "completed_with_warnings",
  "totalRecords": 62,
  "metrics": {
    "report": {
      "version": 2,
      "categories": { "doctors": { "verified": 62, "created": 0, "updated": 2, "unchanged": 60, "errors": 0 } },
      "totals": { "verified": 62, "created": 0, "updated": 2, "unchanged": 60, "errors": 0 },
      "stages": [{ "name": "push_to_doctoralia", "durationMs": 1200 }],
      "agendas": { "unchanged": 16, "managed_scope_pending": 3 },
      "errors": 0,
      "warnings": 3
    }
  }
}
```

## Banco, publicação e retorno

A migration `20260911_sync_managed_ranges` adiciona somente `SlotPushState.managedState JSONB` nullable. Não apaga dados nem inventa intervalos para hashes antigos. Estados antigos totalmente vazios na origem ficam pendentes de conferência; quando um payload não vazio coincide com o hash anterior, seu histórico pode ser reconstruído sem envio remoto. Hash, clínica, estabelecimento, profissional, endereço e janela são conferidos antes de limpeza.

Aplicar a migration antes de executar a imagem nova, coordenando backup/retorno com infraestrutura conforme PUBLICACAO.md do checkout principal. Não executar `db push` em produção. O histórico existente de migrations, sozinho, não cria todos os campos do schema atual (ex.: IntegrationConnection.cachedToken); conferir o estado real do banco antes da janela. Não habilitar migrações globais por conveniência.

Rollback da aplicação: retornar à imagem anterior preservando a coluna adicional. Não fazer backfill reverso ou apagar o histórico. Retornar imagem não desfaz chamadas já aceitas pela Doctoralia. Publicação exige atualização/reinício apenas da aplicação vismed; Redis/PostgreSQL compartilhados e demais serviços devem ser preservados. Nenhum push, deploy ou mudança em produção faz parte desta entrega local.

## Validação

- `npm ci` com lockfile da base; nenhuma dependência alterada.
- Build API e build web aprovados; TypeScript web verificado separadamente, pois o build web desabilita essa checagem. O build web emitiu aviso existente de SWC/lockfile, sem impedir a construção.
- 301 testes de sync em 23 suítes aprovados; incluem os dois pipelines com Prisma/PostgreSQL real e clientes externos simulados, prazo persistido, falha/repetição, contagens, limpeza segura e planos.
- Dois testes de renderização do componente de relatório aprovados (`node --test apps/web/tests/sync-run-report.test.cjs`). A validação posterior no navegador e a escrita na homologação estão descritas abaixo.
- Suíte API ampliada: 1.117 aprovados, quatro falhas na montagem de dependências de AuthController/AuthService/UsersController/UsersService. Esses arquivos não fazem parte do ajuste.
- ESLint dos quatro novos módulos de produção aprovado. ESLint dos arquivos legados alterados continua com violações de formatação/tipagem e exclusão de specs pelo tsconfig; o lint geral não está aprovado. Não foram importados os lotes suspensos de testes/lint/dependências.
- Migration aplicada em PostgreSQL descartável, contexto Docker Desktop local, porta 55439/banco sync_test e dados fictícios. O schema desse banco de teste foi alinhado depois com `prisma db push` devido à lacuna preexistente do histórico. Isso não foi feito em banco de produção.

Para repetir os testes de integração, `SYNC_TEST_DATABASE=true` requer `DATABASE_URL` apontando estritamente para `127.0.0.1:55439/sync_test`; o teste recusa outros alvos. As rotinas externas são simuladas. O container de teste pode permanecer parado para repetição futura.

Após uma publicação autorizada: conferir o primeiro ciclo e o seguinte, resultados de catálogo `catalog_*_refreshed`/`catalog_fresh`, duração, contagem e pendências por endereço. Confirmar com a clínica os planos aceitos quando houver opções múltiplas. Não estimar economia real sem essa medição.

Referências do contrato Doctoralia: [documentação oficial](https://integrations.docplanner.com/docs/) e [modelo ReplaceSlotsRequestSlots do SDK oficial](https://github.com/DocPlanner/integrations-api-sdk-php/blob/develop/docs/Model/ReplaceSlotsRequestSlots.md). Consultadas em 11/09/2026.

## Revisão adicional antes de produção

Verificações locais concluídas em 11/09/2026, após autorização do usuário:

- Criado checkout separado da base `f88bb85`, instalado com seu próprio `npm ci` e cliente Prisma gerado do schema anterior. Os mesmos quatro testes de AuthController/AuthService/UsersController/UsersService falham ali pela ausência de providers no TestingModule. Portanto não são regressões deste pacote. Não foram mescladas as branches suspensas nem corrigidos esses testes fora do escopo.
- Comparado ESLint da base e do candidato. Corrigidas as violações não relacionadas a formatação nas linhas novas/alteradas: preservação do tipo de retorno do upsert, tipagem dos planos e metadados e variável de erro não utilizada. Auditoria das linhas alteradas dos seis módulos legados: nenhuma ocorrência além de Prettier. Os módulos novos passam integralmente no lint. O lint geral continua reprovado por dívida de tipagem legada e formatação; não foi feita reformatação ampla.
- Acrescentada proteção à limpeza: além de conferir histórico/hash/escopo, o vínculo atual da clínica deve estar LINKED e apontar para o profissional remoto selecionado. Dois testes cobrem vínculo removido e vínculo apontando para outro profissional. Metadados de intervalos inválidos são recusados antes da gravação.
- Validação final: **304 testes de sync aprovados**, 23 suítes; builds API/web aprovados e TypeScript web separado aprovado. A suíte ampliada anterior segue como evidência dos módulos não afetados; não foi declarada uma nova execução completa dela.
- No PostgreSQL local descartável, a SQL exata da migration foi executada em tabela temporária com registro legado, dentro de transação desfeita. Preservou o hash e criou managedState nulo. A conferência de metadados identificou todas as colunas escalares exigidas pelo candidato nesse banco de teste já alinhado.
- O Prisma gerado da base conseguiu criar, ler e atualizar um registro fictício no banco com a coluna adicional. A atualização antiga preservou os metadados e mudou o hash; a checagem de hash do candidato distingue esse histórico desatualizado. Isso valida compatibilidade do cliente de banco, não um rollback completo de imagem/serviço.
- Fluxo web conferido no navegador local: login fictício, seleção de clínica fictícia, dashboard, abertura do histórico, expansão da composição e disparo manual contra servidor HTTP simulado. Confirmados a tabela, as agendas pendentes, o aviso de contagem antiga e o status parcial. Ajustada a apresentação do selo de pendência e a largura da composição. A mensagem sobre planos orienta conferência sem afirmar indisponibilidade universal.

### Homologação externa concluída

Após a investigação inicial da conta real, o usuário confirmou a unidade Medical Center Bruno Mendes Test como ambiente de testes/homologação. Em 11/09/2026, das 15:37:58 às 15:38:06 (Brasília), o código compilado do candidato `93f20648aac084f2ccedc7bc7f67e49886247b1d` executou criação, repetição e remoção de um intervalo fictício com o cliente HTTP real da Doctoralia.

- Profissional Aaron Gusmão Test; unidade 140548, profissional 1396868, endereço 1750984. Intervalo de 14/09/2026, 10:00–10:30.
- Leitura inicial confirmou ausência de horários, reservas e bloqueios no dia. Criação retornou 201 e leitura posterior confirmou o horário.
- Repetição sem alteração dispensou novo PUT. Remoção dos intervalos gerenciados retornou 201 e a leitura posterior confirmou retorno ao estado vazio inicial.
- Calendário permaneceu habilitado. Nenhuma consulta real foi criada ou cancelada. Não foi necessária recuperação adicional.
- O teste utilizou disponibilidade e persistência locais isoladas; não constitui teste integral de extração Vissmed nem restauração de uma agenda real preexistente. Valida envio, ausência de reenvio e remoção efetivos na integração externa.

Evidências locais fora do Git: `sync-sandbox-write-result.json` e `sync-sandbox-write-report.md`, na pasta de trabalho Orquestrador. Não é necessário repetir a escrita para liberar o pacote.

### Conferência operacional em 11/09/2026

- Produção ainda executa imagem `sha256:16e4d41a0f7920c78d7a07d81426a721a76fd950558c3bed3aa0b09d982e45ac`, container iniciado em 08/09, sem reinícios contabilizados. O commit Git dessa imagem não foi identificado; não é inferido da main.
- TAR preservado fora do repositório teve SHA-256 reconferido: `166a2dd5c09ef30cc4f486dc5cfe5708d881e771a98bdcc88d13b409caf52142`. Carregamento no Docker Desktop local retornou o mesmo ID de imagem. Execução isolada, sem rede e sem o entrypoint de produção, carregou Node e Prisma corretamente. Não equivale a ensaio completo de troca/retorno do serviço.
- Consulta de metadados em transação READ ONLY no banco real confirmou todas as colunas escalares do Prisma da imagem atual. A lista dessas colunas é idêntica à do candidato excluindo apenas `SlotPushState.managedState` (hash comparativo `ad7897de991d388d910f2f54a1c915cfe92b7391bf1e225800accc14b21c88a9`). A nova coluna ainda está ausente, como esperado.
- Não foi encontrada a coluna `public._prisma_migrations.migration_name`; não há ledger Prisma nesse schema. Aplicar somente a SQL específica aprovada antes do novo runtime, sem migrações globais. Nenhum ALTER foi executado em produção.
- Backup informado pelo usuário: 11/09/2026 às 03:06. Escopo, referência/localização e confirmação de restauração pela infraestrutura ainda não foram informados.

### Condições que permanecem antes de publicar

1. Infraestrutura confirmar escopo, referência/localização e procedimento de restauração do backup informado. O schema real já foi conferido em leitura.
2. Completar preservação segura da configuração de runtime e confirmar o procedimento de substituição/retorno somente do vismed, conforme AGENTS.md/PUBLICACAO.md. Imagem preservada e carregamento local verificados; não houve ensaio de rollback no servidor. O commit de origem da imagem atual continua sem identificação.
3. Na janela autorizada, aplicar exclusivamente a SQL da coluna nova antes de iniciar o candidato; o teste externo está concluído.
4. Conferir os planos aceitos e os horários antigos pendentes com a clínica antes de qualquer correção manual desses dados. A aprovação do pacote não escolhe planos pela clínica.
5. Solicitar autorização de envio Git/publicação após apresentar o pacote e a situação dos controles. Nenhum push, migration de produção ou deploy foi executado nesta revisão.

Conclusão: validações de código e homologação externa encerradas; publicação ainda depende dos controles operacionais descritos e de autorização explícita.
