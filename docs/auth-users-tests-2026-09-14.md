# Testes de autenticação e usuários — 14/09/2026

## Escopo e resultado

Base: `183ec82ac74dcea13068a7467373ea0f3c7cb73d` (main remota conferida). Branch independente `codex/auth-users-behavior-tests`; não incorpora branches suspensas nem o ajuste ainda não publicado de compensação de agendamentos.

Foram substituídos os quatro testes incompletos de inicialização por cenários de comportamento e adicionadas verificações de permissão. Somente testes, fixture, configuração de tipagem de testes e este relatório foram alterados. Nenhuma mudança em regras de autenticação, perfis, banco ou código de produção; sem push/deploy.

Execução final: **38 testes, 36 aprovados, dois reprovados; cinco suítes aprovadas e uma reprovada**. As quatro suítes antigas passaram após completar sua preparação.

Cobertura de cenários (não é percentual de cobertura):

- Login com credenciais válidas e token verificável; usuário inexistente, senha incorreta e campos ausentes.
- Perfil autenticado; rejeição de token ausente, inválido, expirado, assinado com outra chave ou associado a usuário inexistente.
- Não expor senha no perfil, na resposta de login ou nas listagens; propagar falha de consulta sem emitir token.
- Bloquear chamadas sem autenticação para listar, criar, atualizar e excluir usuários.
- Alterar apenas o próprio nome pelo endpoint de perfil; rejeitar nome vazio e ignorar ID/perfil de acesso enviados nesse formulário.
- Exigir senha atual correta na troca; rejeitar senha nova ausente/curta e armazenar hash.
- Guard de perfis com metadados reais: permite o perfil exigido e rejeita Operador/usuário sem perfil em rota que exige Super Admin.

## Dois testes de restrição reprovados

Ambos usam um usuário autenticado fictício com **somente OPERATOR** em uma clínica fictícia:

| Operação | Critério testado | Resultado observado localmente |
|---|---|---|
| GET `/api/users` | Negar administração a Operador: 403 e zero consultas | 200 e uma chamada a `user.findMany` simulado |
| DELETE `/api/users/synthetic-other` | Negar exclusão de outro usuário: 403 e zero exclusões | 200 e uma chamada a `user.delete` simulado |

Os testes permanecem explícitos e reprovados; não foram ignorados nem alterados para aceitar o acesso. O critério é que um perfil não administrativo não gerencie outros usuários. A matriz completa de Super Admin/Administrador de Clínica/Operador ainda deve ser definida para uma correção, inclusive o limite entre clínicas.

Causa conferida: `UsersController` usa `JwtAuthGuard` e `RolesGuard`, mas não declara `@Roles` nas rotas administrativas. `RolesGuard` permite a execução quando não há perfil exigido. Não existe `APP_GUARD`/`useGlobalGuards` adicional em `src` que estabeleça essa restrição. O teste separado com `@Roles(SUPER_ADMIN)` confirma que o guard funciona quando configurado.

Isso demonstra ausência de restrição por perfil no código testado. Não demonstra exploração, exclusão real ou incidente em produção. As duas falhas têm uma causa comum; não são novos defeitos na validação de senha ou token.

## Ambiente e reprodução

Dependências instaladas do lockfile em volumes novos e exclusivos de teste, usando Node 20 em Docker Linux. Testes executados com `--network none`, sem `.env`, tokens reais, contas reais ou conexões de banco. JWT, bcrypt, strategy e guards reais; somente acesso ao banco é simulado nos testes HTTP. Supertest acessa uma instância local descartável, fechada no final de cada suíte. O prefixo `/api` é aplicado somente pela fixture para representar a URL pública; não testa o proxy do frontend.

```sh
npm test --workspace=apps/api -- --runInBand auth.controller.spec.ts auth.service.spec.ts roles.guard.spec.ts users.controller.spec.ts users.service.spec.ts users.permissions.spec.ts
npx tsc -p apps/api/tsconfig.auth-tests.json
```

Tipagem dos arquivos de teste e fixture aprovada. Não houve build/reinício da aplicação, pois não há mudança de runtime. A suíte geral de sincronização não foi repetida: este lote só muda os testes de Auth/Users. Não foram validados navegador, proxy, rate limiting ou todas as permissões multiclínica.

Documentação técnica consultada via Context7: [testes NestJS com TestingModule e Supertest](https://github.com/nestjs/docs.nestjs.com/blob/master/content/fundamentals/unit-testing.md). Não substituímos os guards nos testes HTTP.

## Próximo ajuste recomendado

Definir e aplicar permissões nas rotas administrativas e o escopo da clínica antes de disponibilizar gestão de usuários às clínicas. Preservar os endpoints de perfil próprio. Depois, executar estes mesmos testes e ampliar os cenários para criação/edição e acesso entre clínicas. Este relatório não autoriza publicação ou mudança de perfis existentes.
