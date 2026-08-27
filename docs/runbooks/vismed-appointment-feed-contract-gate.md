# Gate do contrato do feed de agendamentos Vissmed

## Fonte autoritativa

O contrato do feed é definido exclusivamente pelo registry versionado no backend,
usando a URL canônica de `IntegrationConnection.domain`. O campo legado
`vismedAppointmentFeedMode` não seleciona, sobrescreve nem fornece fallback.

Bases atualmente classificadas:

- `https://app.vissmed.com.br/api-docctor-3` — `INCREMENTAL`
- `https://app.vissmed.com.br/api-docctor-5` — `INCREMENTAL`
- `https://app.vissmed.com.br/api-vissmed-4` — `LEGACY`

## Cadastrar ou alterar uma instância

1. Comprove a URL canônica e o contrato do feed em configuração ou documentação
   confiável. Não deduza o contrato pelo conteúdo do feed.
2. Adicione ou altere a entrada no registry por mudança versionada.
3. Inclua testes de canonicalização, resolução e fail-closed.
4. Faça build e execute as suítes focadas de regressão.
5. Publique o registry e seu consumidor na mesma versão.

Uma URL ausente, inválida ou não cadastrada resulta em `UNCLASSIFIED`. Nesse estado,
nenhum timer novo é criado e cada execução individual é bloqueada antes de resolver
unidades ou ler o feed. Os demais fluxos Vissmed e o status da conexão não mudam.

## Rollout

Não mantenha simultaneamente réplicas novas e antigas sem controle: versões antigas
ainda podem obedecer ao campo por conexão, enquanto a versão nova obedece somente ao
registry. Faça substituição coordenada das réplicas ou mantenha temporariamente os
valores legados coerentes até todas as réplicas antigas saírem de circulação.

Após o rollout, confirme nos logs:

- `VISMED_APPOINTMENT_FEED_CLASSIFIED`, com instância, modo e
  `source=INSTANCE_REGISTRY`, para bases admitidas;
- `VISMED_APPOINTMENT_FEED_UNCLASSIFIED` para bases bloqueadas;
- `VISMED_APPOINTMENT_FEED_MODE_DIVERGENCE` quando o campo legado divergir, sem
  alterar o modo derivado do registry.

Não faça chamadas exploratórias a `get-agendamento-filtros` para classificar uma
base. O contrato deve vir de evidência técnica confiável e entrar por revisão de
código. Esta mudança não autoriza deploy, ativação de conexões ou alteração de banco.