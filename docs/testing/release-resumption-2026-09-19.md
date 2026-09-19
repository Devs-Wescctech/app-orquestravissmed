# Retomada da publicação — 19/09/2026

Escopo confirmado pelo usuário: concluir painel, publicação segura e conferência posterior, sem ampliar a homologação de múltiplos serviços. Esse cenário permanece como limitação documentada; divergência de leitura impede remoção automática.

## Conferências realizadas

- Chrome voltou a responder. Orquestrador acessível com a sessão existente.
- Inspeção somente leitura de `/sync`: motivos carregaram ao clicar em “Ver motivos e próximos passos”; expansão dos eventos de remoção apresentou os dois avisos existentes. Screenshot confirmou texto legível e eventos dentro do cartão no viewport desktop atual.
- Essa evidência pertence à versão atualmente servida, não ao candidato. O texto antigo de preservação ainda aparece; não declarar a alteração do painel candidato validada por esta inspeção. Sem comparação visual de baseline, teste mobile ou auditoria completa.
- Candidato local antes deste registro: `2920505a62b6ff47d8ddff411d486476e33999a9`, árvore limpa. Revisão de publicação consultou main remota `943b93b070c65dac19a7beac67dac869957f6bd1` e retornou sem bloqueios/avisos Git. Isso não certifica controles operacionais.
- Portainer abriu na tela de login. Solicitado login ao usuário, sem solicitar senha no chat.

## Ainda pendente

Validar visualmente o candidato; identificar imagem/commit atual e configuração recuperável; confirmar preservação e retorno, gatilhos reais, compatibilidade/backup pertinente e simulação direcionada no servidor. Somente depois publicar exclusivamente `vismed` e validar imagem, saúde, ciclo de sincronização e preservação de Redis.

Nenhum push, merge, deploy, sincronização manual, alteração de agenda ou operação de infraestrutura nesta retomada. Não usar Pull and redeploy global. Testes anteriores não foram repetidos: não houve mudança no runtime.

## Portainer após login

Leitura autenticada confirmou environment 3, stack 40 `orquestrador_vissmed`, repositório esperado e Compose `docker-compose.portainer.yml`.

- Aplicação: container `f086e148a60273ab63ffc3df0a2795b4dd9ea9802f25f1dff925eaac33539eac`, running, RestartCount 0, StartedAt `2026-09-18T10:28:33.649789939Z`.
- Inspect do container confirmou imagem efetiva `sha256:77dba8e404cf4147dee8bf266ae837581379c57b368251ddaceacefa4b9c5c5b`. A tag `vismed:latest` resolve atualmente ao mesmo ID. Commit não comprovado.
- Redis: container `ba8493d2c736914f0c615cc65f8af3545f4e227be1f8068ffac2b22ee97b9b79`, healthy na listagem. Sem alteração.
- Labels indicam projeto `orquestrador_vissmed`, working_dir `/data/compose/40` e config_files `/data/compose/40/docker-compose.portainer.yml`. Esses caminhos são evidência dos labels, não comprovação de caminhos equivalentes acessíveis no host.

A UI oferece Pull and redeploy da stack; não acionado. Ainda falta acesso operacional aprovado ao host para validar configuração privada, preservação da imagem e simulação exclusiva de vismed, além da confirmação pertinente de backup pela infraestrutura. Nenhuma credencial foi copiada; nenhuma imagem foi retagueada/exportada; nenhum container foi alterado.

## Preparação final autorizada

O usuário reiterou explicitamente publicação por Pull and Redeploy após ser informado do risco de recriação do Redis; essa autorização atual substitui a restrição operacional anterior para esta janela. Backup de servidor/banco permanece responsabilidade da infraestrutura e não é executado nesta tarefa.

- Imagem atual preservada no mesmo daemon como `vismed:rollback-20260919-77dba8e404cf`; UI confirmou tag e mesmo SHA256 registrado acima. Exportação solicitada pela UI; conclusão do arquivo ainda não confirmada, portanto não afirmar cópia externa verificada.
- GitOps visualmente desligado; referência `refs/heads/main` confirmada, sem alteração de configuração.
- Fixture `node scripts/preview-cleanup-panel.cjs`, somente loopback, renderizou os componentes reais do candidato e CSS do build existente com eventos fictícios. No Chrome: carregamento desabilitado, erro controlado, nova tentativa, exibição do texto corrigido, expansão dos dois eventos e contagem de três agendas pendentes funcionaram. Screenshot desktop conferido, sem corte de conteúdo no cartão. Não é E2E com API/banco nem comparação automatizada de baseline/mobile.
- Sem mudança de schema, migrations, Dockerfile, Compose, lockfile ou boot neste pacote em relação à base. JSON managedState adiciona dados opcionais; retorno de imagem não desfaz operações na Doctoralia.
- Retorno previsto: selecionar a imagem preservada na recriação exclusiva do container vismed, conservar parâmetros atuais e desativar pull da imagem. Não usar Pull and Redeploy de main como rollback. Retorno em produção não foi executado/testado nesta preparação.

## Resultado da publicação

- Push da branch e avanço fast-forward autorizado de main concluídos: `e43ca95981511f7e8c13e41c514f11aae68dfd1e`, confirmado com ls-remote. Sem PR, force-push ou mistura das branches suspensas.
- Pull and Redeploy executado pela UI; opção adicional Re-pull image and redeploy permaneceu desligada. GitOps não foi ativado.
- Novo vismed: `9bb96c787fb2c40248c9f0c29ba66cfbdc45c16977c960a1bb5a24e933593e39`; imagem efetiva confirmada pelo Inspect `sha256:8dee41d805a0dc8a60afe093ba75b7a3714ac3a822ce122b0f14326f7a3a185f`; StartedAt `2026-09-19T23:06:48.80066689Z` (20:06 Brasília); running, RestartCount 0 na leitura.
- Redis também foi recriado: novo ID `dcb977d6a9b68f51fbc89d9a8858848931bbbbd14f5bd200d23b82a9f6c52f9d`, healthy. Não declarar preservação do processo ou das filas anteriores. Não houve reinício adicional para corrigir esse efeito.
- Após reload autenticado, `/sync` carregou dados da clínica e o texto novo de limpeza não concluída/confirmada, comprovando atualização do frontend. Motivos carregaram da API sem erro visível.
- Logs da nova aplicação confirmaram inicialização Nest, scheduler ativo, handlers de filas registrados, polling Doctoralia sem notificações e dois ciclos incrementais VISSMED completos (`fetchComplete=true`, recebidos/processados zero) após o boot. Não foi criado agendamento real nem forçada sincronização global. Ciclo global de 30 minutos não foi aguardado; não afirmar homologação integral de todos os fluxos em produção.
- Sem migration executada por esta tarefa, sem administração de backup de servidor/banco, sem alteração do PostgreSQL/proxy. Fixture local encerrada após a verificação.

Limitações mantidas: dois serviços com leitura divergente permanecem protegidos por pendência; rollback não ensaiado em produção; arquivo de exportação da imagem não confirmado. A preservação comprovada é a tag exclusiva no daemon.
