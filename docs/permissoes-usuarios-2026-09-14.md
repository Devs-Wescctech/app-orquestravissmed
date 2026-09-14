# Permissões de gestão de usuários — correção local

Decisão confirmada pela usuária em 14/09/2026: **gestão somente pelo Super Admin**. Desenvolvimento na branch `codex/auth-users-behavior-tests`, sobre main `183ec82ac74dcea13068a7467373ea0f3c7cb73d` e os testes locais `999b376`. Nenhum push ou deploy nesta etapa.

## Explicação para a equipe

Antes, a API exigia que a pessoa estivesse logada, mas não exigia perfil administrativo para gerenciar usuários. Nos testes, um Operador conseguia listar usuários e solicitar a exclusão de outro usuário.

Depois deste ajuste:

| Perfil | Gestão de usuários, permissões e vínculos | Próprio nome e senha | Seleção das clínicas acessíveis |
|---|---|---|---|
| Super Admin | Permitida em todas as clínicas | Permitida | Todas, conforme regra existente |
| Administrador de Clínica | Bloqueada | Permitida | Somente vínculos existentes |
| Operador | Bloqueada | Permitida | Somente vínculos existentes |
| Somente Leitura | Bloqueada | Permitida | Somente vínculos existentes |
| Sem vínculo/perfil | Bloqueada | Permitida enquanto a conta estiver ativa | Lista vazia, conforme regra existente |
| Conta desativada | Bloqueada | Acesso autenticado bloqueado | Bloqueada |

A proteção está na API, mesmo que alguém tente acessar uma URL diretamente ou alterar dados enviados pelo navegador. Rotas da gestão central de clínicas também foram protegidas, pois permitiam consultar usuários e criar/remover vínculos por outro caminho. `/clinics/my`, usado para selecionar as próprias clínicas, foi preservado.

Não basta inserir `SUPER_ADMIN` no corpo da requisição ou no conteúdo de um token: a autorização usa o cadastro consultado pela estratégia JWT. Nas novas requisições, um token antigo não mantém privilégios revogados. Uma conta desativada não consegue fazer novo login nem usar token anterior.

As telas de gestão mostram aviso de acesso restrito para outros perfis. O dashboard usa a consulta das clínicas acessíveis e não busca a lista global de usuários para quem não pode administrá-los; a contagem restrita aparece como “—”, com explicação, e não como zero.

## Proteções complementares

- Atualização de usuários aceita somente nome, e-mail, senha e status; operações arbitrárias de banco ou alteração de vínculos dentro desse payload são rejeitadas.
- Criação valida campos, perfil e clínica. Vínculos/perfis de contas existentes continuam no endpoint específico da gestão de clínicas.
- Respostas de criação, edição, consulta e exclusão não expõem o hash da senha.
- Super Admin não pode excluir/desativar a própria conta nem remover/rebaixar seu próprio vínculo pelo endpoint de vínculos. Isso é proteção dessas ações diretas, não uma garantia transacional de que sempre haverá um administrador após qualquer combinação de operações concorrentes ou exclusão de clínicas.
- Troca da própria senha continua exigindo a senha atual; alteração do próprio nome não aceita mudança de ID ou perfil.

## Contratos HTTP

As rotas abaixo já existiam; não foram criados novos endpoints. Todas exigem Bearer JWT válido.

| Método/rota da API | Autorização e entrada | Resposta |
|---|---|---|
| GET `/users` e GET `/users/:id` | Super Admin | Lista/perfil sem senha, formato existente |
| POST `/users` | Super Admin; `name`, `email`, `password` obrigatórios; `active`, `clinicId`, `role` opcionais. `role` exige `clinicId` | 201, usuário criado sem senha |
| PUT `/users/:id` | Super Admin; somente `name`, `email`, `password`, `active` | 200, usuário atualizado sem senha |
| DELETE `/users/:id` | Super Admin; proíbe o próprio ID | 200, usuário excluído sem senha |
| GET/PUT `/users/me/profile` | Qualquer usuário ativo autenticado; PUT altera somente `name` | Perfil sem senha |
| PUT `/users/me/password` | Qualquer usuário ativo autenticado; `currentPassword`, `newPassword` | 200, `{ "success": true }` |
| GET `/clinics/my` | Qualquer usuário ativo autenticado | Clínicas acessíveis pela regra existente |
| Demais rotas de `/clinics` | Super Admin; mesmos métodos, parâmetros e contratos existentes | Mesmo formato de resposta |
| POST `/clinics/:id/users` | Super Admin; `userId`, `role` válido opcional (padrão OPERATOR); proíbe auto-rebaixamento | Vínculo criado/atualizado |
| DELETE `/clinics/:id/users/:userId` | Super Admin; proíbe remover o próprio vínculo | Vínculo removido |

URLs públicas recebem o prefixo `/api` do proxy. Exemplos de corpo, somente dados fictícios:

```json
{ "name": "Pessoa de Teste", "email": "pessoa@example.invalid", "password": "senha-ficticia-123", "clinicId": "clinica-teste", "role": "READONLY" }
```

```json
{ "name": "Nome Atualizado", "active": true }
```

Erros novos/validados: 401 para autenticação ausente/inválida/conta desativada; 403 para perfil sem permissão; 400 para campos inválidos/não permitidos e ações diretas contra a própria conta administrativa. Paginação, rate limiting e erros de persistência existentes não foram redesenhados neste lote. Senha mínima mantém seis caracteres, coerente com a troca de senha já existente.

## Validação e limites

- 81 testes direcionados de autenticação, autorização, entrada e caminhos alternativos passaram.
- Suíte geral da API: **1.237 aprovados, zero falhas, 13 ignorados conforme configuração existente** (70 suítes aprovadas e duas ignoradas).
- Frontend: **18 testes aprovados**, incluindo regra de visibilidade e renderização do aviso.
- TypeScript separado da API, dos testes/fixture e do frontend passou. O build Next ignora tipagem por configuração anterior, por isso a checagem separada é necessária.
- Build Docker final da API e do frontend concluído com sucesso, tag local `vismed:permissions-local-20260914`. O Next emitiu aviso sobre tentativa de completar dependências SWC no lockfile durante o build; o build concluiu e os manifests/lockfile versionados não foram alterados.
- PostgreSQL 16 descartável e rede Docker interna exclusivos dos testes gerais; nenhuma conexão com bancos ou APIs de clínicas reais. Banco e rede temporários removidos após os testes.
- O lote não muda schema, migrações, rotinas de sincronização, payloads de agendamento ou seus vínculos. Não houve teste com agendamentos reais nem navegação interativa nas telas de produção.
- Não constitui auditoria completa de autorização dos demais módulos. Os 13 testes ignorados não são declarados aprovados. O lote de compensação de recusas VISSMED, em outra branch local, ainda exige integração e validação conjunta antes de uma publicação combinada.

## Publicação e retorno

Nenhuma conta ou perfil real foi modificado. Não precisa reiniciar produção para guardar os testes/alterações locais. Para ativar a correção, preparar publicação autorizada somente do aplicativo, conforme AGENTS.md, com imagem anterior preservada e verificação da conta administrativa na janela. O schema é compatível com a versão anterior; retornar o código reabre a ausência de restrição corrigida aqui e não desfaz alterações administrativas feitas após a publicação. A infraestrutura permanece responsável por backup/recuperação.
