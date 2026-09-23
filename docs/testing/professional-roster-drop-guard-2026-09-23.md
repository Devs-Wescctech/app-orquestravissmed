# Proteção contra queda anormal da lista de profissionais — 23/09/2026

## Impacto avaliado antes da alteração

A elegibilidade é consultada antes de ativar calendários, publicar horários e executar a sincronização Doctoralia. O fluxo já distingue `enabled`, `excluded` e `unknown`: `unknown` suspende novos envios e não inicia a limpeza de horários. O polling de consultas é organizado por clínica e não foi alterado. O histórico de vínculos e atendimentos também não é modificado por esta proteção.

## Critério aplicado

Somente quando um profissional está ausente da lista filtrada da instância confirmada da Vissmed:

- Lista vazia: `unknown` (`abnormal_roster_drop`). Nenhuma ausência em massa autoriza limpeza.
- Com pelo menos três médicos ativos vinculados à clínica no banco, se metade ou mais deles desaparecerem simultaneamente da lista: `unknown` (`abnormal_roster_drop`).
- Nas demais ausências: `excluded`, preservando a retirada individual esperada.
- Profissional presente e habilitado: `enabled`, sem consultas adicionais ao banco.
- Flag explícita `mostrarnadoctoralia=0` ou `ativo=0`: `excluded`, sem depender da comparação de volume.

A comparação considera somente vínculos `DOCTOR` com status `LINKED` da clínica e médicos locais ativos. A consulta adicional ocorre apenas para um profissional ausente. Erro nessa leitura produz `unknown`. Não há cache de autorização, escrita no banco, migration, mudança de endpoint, dependência, cron ou contrato de API.

## Limite operacional

Uma retirada legítima de todos os profissionais, ou de pelo menos metade de uma clínica com três ou mais vinculados, ficará pendente enquanto a Vissmed retornar apenas a lista reduzida. Nesse caso a segurança prevalece sobre a limpeza automática: horários já publicados podem permanecer, e novos envios desses profissionais ficam suspensos. É necessário revisar o retorno e o estado da integração antes de tratar a retirada coletiva. Essa regra não prova que toda resposta não vazia é completa; uma queda menor que o limite pode passar.

O registro desta mudança e seus testes locais não comprovam a versão em execução no Portainer. Push e publicação seguem os controles de `AGENTS.md` e `PUBLICACAO.md`.

## Verificação local

- Dependências instaladas em checkout isolado a partir do lockfile. O binding opcional de Windows ausente no lockfile foi colocado somente em `node_modules` para executar o Jest; manifests e lockfile não foram alterados.
- Regressão relacionada: 9 suítes e 110 testes aprovados. A suíte PostgreSQL (5 testes) foi ignorada por exigir a base descartável `sync_test` configurada para esse fim.
- TypeScript da API (`--noEmit`) e ESLint do módulo alterado: aprovados.
- Build da API (`npm run build --workspace apps/api`): aprovado.
