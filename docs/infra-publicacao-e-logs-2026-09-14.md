# Preparação para infraestrutura: publicação direcionada e histórico de logs

Proposta preparada; nenhuma alteração no servidor, Redis, Docker ou Portainer.

## Publicar somente a aplicação

O procedimento já revisado está em `PUBLICACAO-DIRECIONADA-2026-09-12.md` no workspace operacional. Preservar sua simulação e obter equivalência dos arquivos e variáveis efetivos do Portainer antes de executar no host. O modelo usa uma imagem candidata já preparada e um override apenas para `vismed`:

```sh
docker compose --project-name orquestrador_vissmed \
  --env-file <ARQUIVO_PRIVADO_VALIDADO> \
  -f <COMPOSE_EFETIVO> -f <OVERRIDE_DA_IMAGEM> \
  --dry-run up -d --no-deps --no-build --pull never vismed
```

Não é comando pronto para execução: faltam os caminhos efetivos e a imagem da janela. A infraestrutura deve conferir o dry-run no servidor, preservação da imagem anterior e se Redis mantém ID, imagem, StartedAt e RestartCount. Aplicar a operação validada somente após autorização. Um novo Pull and redeploy global não equivale a esse procedimento.

## Preservar logs após recriar a aplicação

Rotação limita espaço; sozinha não é uma estratégia de retenção independente do container. Antes de outra publicação, a infraestrutura deve escolher um destino interno persistente para os logs de `vismed`, com prazo, limite de espaço e acesso restrito definidos por ela. Preferir o coletor que já administra, sem instalar outro produto por iniciativa desta tarefa.

Preparação específica:

1. Informar coletor/destino interno existente, transporte aceito e retenção aprovada; não enviar credenciais ao chat.
2. Configurar somente o serviço `vismed`, ou a seleção equivalente no coletor. Não alterar o driver padrão do daemon nem reiniciar Docker.
3. Incluir data UTC, serviço, ID do container e versão da imagem nos registros. Não adicionar payloads de pacientes, tokens ou senhas.
4. Definir comportamento durante indisponibilidade do coletor: limite do buffer, impacto na aplicação e alertas de perda. Não assumir retenção garantida se existir descarte.
5. Ensaiar em ambiente isolado: emitir marcadores sintéticos, recriar somente o aplicativo, recuperar os marcadores anteriores e posteriores e verificar que o Redis não mudou.
6. Na janela aprovada, verificar recebimento de novos logs e acesso ao histórico anterior à troca. Não prometer recuperação de logs que já foram removidos.

Não há destino confirmado para produzir um override executável de logging. Essa dependência é da infraestrutura, não da VISSMED. A simples ausência de destino não impede concluir os ajustes locais de negócio.

Fontes técnicas consultadas via Context7 em 14/09/2026: [logging por serviço no Compose](https://github.com/docker/docs/blob/main/content/reference/compose-file/services.md), [driver json-file e rotação](https://github.com/docker/docs/blob/main/content/manuals/engine/logging/drivers/json-file.md), [configuração de logging](https://github.com/docker/docs/blob/main/content/manuals/engine/logging/configure.md). Configurar um novo driver exige recriar o container; containers existentes não recebem automaticamente a configuração nova.
