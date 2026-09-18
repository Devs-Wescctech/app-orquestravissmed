# Verificação complementar: publicação bloqueada

> Histórico do defeito. A correção posterior suspende a limpeza destrutiva; consulte [evidência atual](professional-eligibility-fix-2026-09-18.md). A remoção seletiva permanece não implementada.

Código de produção verificado: `34f1ab6333cc75ad5ec55f0fdddea4aff96a4457`.
Esta rodada só acrescenta testes/evidências; não corrige a falha encontrada.

## Bloqueador funcional confirmado na Doctoralia

Usuário confirmou explicitamente a homologação Medical Center Bruno Mendes Test (facility 140548), Aaron Gusmão Test (1396868), endereço 1750984. Dia exclusivo de teste: 21/09/2026. Antes de escrever, o executor conferiu facility, endereço, calendário ativo, serviço e ausência de slots/reservas/bloqueios no dia.

1. PUT criou dois intervalos sintéticos: 08:10–08:40 e 09:10–09:40 (UTC-3). GET confirmou os dois.
2. Somente o primeiro foi registrado como gerenciado no PostgreSQL local. O segundo era controle e deveria permanecer.
3. Callback de elegibilidade não confirmada impediu a limpeza, sem PUT adicional.
4. Com exclusão confirmada, `DisabledProfessionalSlots.clear` enviou somente 08:10–08:40 com `address_services: []`.
5. GET posterior retornou **nenhum horário**, em vez de preservar 09:10. A limpeza afetou disponibilidade fora do intervalo registrado. A mesma falha foi reproduzida em segunda execução, com observação explícita:

```text
phase: scoped-clear
expectedStarts: [2026-09-21T09:10:00-03:00]
observedStarts: []
attempted: true
restored: true
writes: 3
```

Em ambas as execuções, o finally limpou os dois intervalos de teste e confirmou por GET o retorno ao estado inicial vazio. Nenhum agendamento de paciente foi criado/cancelado. Guarda de rede restringiu toda escrita ao PUT de slots do endereço de homologação e às duas faixas exatas; nenhum DELETE ou alteração de cadastro foi permitido. Nenhuma escrita VissMed ou publicação ocorreu.

**Consequência:** evidência local de ownership não torna esse PUT uma remoção restrita. A afirmação anterior de preservação de horários alheios não foi confirmada. Não publicar a limpeza atual. O teste não determina o alcance máximo do PUT fora do dia testado nem comprova preservação de reservas preexistentes.

Reprodutor automatizado adicionado em `disabled-professional-slots.spec.ts`: modela substituição observada e exige preservar o controle. Resultado: **1 falha e 12 testes aprovados**. A falha permanece intencionalmente como bloqueador, sem mudar código de produção para mascará-la. A política de limpeza em outros caminhos que usa o mesmo PUT também deve ser revisada.

## Testes complementares aprovados

- TypeScript API: `node node_modules/typescript/bin/tsc --noEmit -p apps/api/tsconfig.json` — aprovado. As tentativas iniciais com tsconfig.build/root não encontraram arquivo; não eram falhas de código.
- PostgreSQL real: **52 testes aprovados**, distribuídos em 7 suítes:
  - Pipeline, deduplicação/lease, timeout e booking claim: 43.
  - Novos testes de elegibilidade/persistência: 4 (conexão por clínica, retomada idempotente, recuperação após timeout, vínculo compartilhado).
  - Consulta HTTP/persistência: 4.
  - Persistência de recusa já presente no candidato: 1. Não incorpora o candidato separado refusal-automation.
- Leitura real VissMed via transporte do candidato: HTTP/array válido, 2 registros; profissional 6983 habilitado, 6735 ausente/excluído. Nenhum nome/CPF/telefone de resposta foi gravado.
- `git diff --check`: aprovado antes do registro final.
- Build e 1.386 testes anteriores não foram repetidos sem necessidade: não houve mudança de produção desde aquela validação. Eles não anulam o novo teste vermelho.

Banco descartável novo `orq-eligibility-test-20260918`, PostgreSQL 16-alpine local, porta somente `127.0.0.1:55439`. Sem credenciais, dados ou .env de produção. Schema do candidato e índice parcial de deduplicação aplicados apenas ali. Bases `sync_test`, `consultation_test` e `refusal_test` contêm somente fixtures. A guarda do teste de recusa aceita agora também esse host/porta local, preservando a exigência de nome de banco dedicado. Nenhum banco de infraestrutura foi administrado.

O Docker Desktop estava parado e foi iniciado para esses testes. Contêineres alheios iniciaram pela própria política de reinício; não foram alterados por comandos desta tarefa. O contêiner criado para estes testes será parado, sem remoção de dados, ao encerrar a validação.

## Lint

Execução sem `--fix` nos dois módulos novos:

- `professional-eligibility.ts`: 50 erros.
- `disabled-professional-slots.ts`: 56 erros e 1 aviso.

Incluem Prettier e regras de acesso/atribuição/chamadas sem tipagem segura e conversão de objeto em string. **Lint não aprovado**. Não são apresentados como erros legados, pois estes módulos são novos. Não houve reformat/rewrite de código nesta solicitação de testes.

## Próximo passo

Corrigir a estratégia de retirada antes de publicação e repetir o cenário de dois horários (gerenciado + controle), incluindo a preservação de reservas/bloqueios quando houver fixtures autorizadas. Se a API não oferecer remoção restrita segura, preservar a disponibilidade e registrar pendência até existir uma estratégia validada, sem usar DELETE amplo como atalho. Também tratar lint dos módulos novos. Não há confirmação ponta a ponta de navegador ou garantia de todos os fluxos sem erros.

Ferramentas/skills: verification-loop orientou checagens; docker-patterns orientou isolamento local; tdd-workflow orientou registro do reprodutor vermelho, sem alteração de produção. Obsidian/Graphify indisponíveis nesta sessão. Nenhum push/deploy.
