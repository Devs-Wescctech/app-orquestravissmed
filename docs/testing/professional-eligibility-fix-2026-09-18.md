# Correção de segurança da limpeza — 18/09/2026

Estado: proteção corrigida; **remoção automática restrita continua indisponível**.
Não houve push/deploy nem modificação de agenda de produção.

## Decisão e efeito

O teste anterior demonstrou que um PUT com serviços vazios removia também o horário de controle. A [documentação oficial](https://integrations.docplanner.com/docs/) descreve replaceSlots como substituição de disponibilidade e DELETE como exclusão por data; não foi validada uma operação atômica para apagar apenas o intervalo gerenciado e preservar os demais.

A correção não tenta reconstruir uma agenda a partir de slots livres (o que pode perder serviços, convênios, intervalos ocupados e alterações concorrentes). Ela impede o PUT destrutivo:

- Profissional excluído: filtro impede novos envios; `DisabledProfessionalSlots.assess` somente lê a evidência local e contabiliza pendências. Não recebe client remoto e não escreve no banco.
- Fonte completa mas vazia: SlotSync registra `managed_scope_pending`, retorna falha/pêndencia e preserva estado/horários. Não envia limpeza vazia nem avança o hash.
- Evidência futura ou ambígua permanece intacta para tratamento posterior. Evidência válida vazia ou inteiramente passada não produz remoção nem pendência nova.
- Logs distinguem ausência de envio de limpeza concluída. Não se registra que horários foram removidos quando nenhuma remoção ocorreu.
- Tipagem dos dois módulos novos corrigida e formatação ajustada sem desligar regras de lint.

**Limitação operacional importante:** horários antigos já publicados para profissional desabilitado podem continuar disponíveis na Doctoralia. Esta correção evita a exclusão de horários alheios, mas não conclui a retirada automática. É necessária uma estratégia de API validada para fazê-la com segurança. Não criar break, cancelar consulta ou desativar calendário inteiro como substituto silencioso.

Nenhuma mudança de schema, dependências, cron, fila de recusas ou configuração de deploy. As rotas de ativação/envio continuam exigindo habilitação. A correção de recusa continua em candidato separado.

## Evidência TDD

- Checkpoint `72e1e41`: RED executado, 3 falhas/22 aprovações, cobrindo profissional excluído, fonte vazia e horário de controle.
- Checkpoint `cede53e`: implementação GREEN, 52 testes focados aprovados. O caminho de remoção não foi simulado como seguro: foi removido e substituído por avaliação somente de leitura.
- Rodada focada com cobertura: 55 testes, 7 suítes aprovadas; módulos novos: 96,77% statements, 94,62% branches, 100% funções, 96,61% linhas. Módulo de pendências: 100% em todas as métricas.
- Build API e TypeScript `--noEmit -p apps/api/tsconfig.json`: aprovados.
- ESLint sem `--fix`, módulos `professional-eligibility.ts` e `disabled-professional-slots.ts`: zero erros/avisos. Não representa aprovação do lint global legado.
- PostgreSQL real: 47 testes em 5 suítes (pipeline, lease/dedup, timeout, claim e nova avaliação); mais 4 de consulta HTTP e 1 de persistência de recusa, executados nas bases dedicadas correspondentes.
- Regressão final, após readiness: 84 suítes/1.436 testes aprovados; 2 suítes/5 testes ignorados por exigirem as outras bases. Esses 5 passaram nas execuções separadas acima: 1.441 testes distintos aprovados no conjunto, sem somar as repetições focadas.
- Primeira rodada com banco falhou porque o PostgreSQL descartável ainda estava recuperando/iniciando; não foi contabilizada como aprovação. Após confirmação de readiness, os testes de banco passaram.
- `git diff --check`: aprovado. Busca limitada de padrões de chaves privadas/tokens no patch não encontrou valores; não equivale a auditoria de segurança completa.

## Homologação real autorizada

Executor: `scripts/test-eligibility-sandbox.cjs --execute-authorized-sandbox`, com build atualizado do candidato e PostgreSQL local `sync_test` em 127.0.0.1:55439. Credenciais da homologação não foram impressas nem copiadas para relatório.

Facility 140548, médico 1396868, endereço 1750984, dia 21/09/2026. Preflight exigiu dia vazio, calendário ativo e identificação da unidade exclusiva de teste.

- Criou faixas sintéticas 08:10–08:40 e 09:10–09:40; GET confirmou ambas.
- Registrou somente a primeira como gerenciada no banco local.
- A avaliação corrigida retornou pendência, sem PUT/DELETE adicional.
- Ambas as faixas permaneceram disponíveis; journal intacto em nova instância/repetição.
- Reservas e breaks continuaram vazios; calendário manteve seu status.
- Finally removeu as duas faixas exclusivamente sintéticas e verificou retorno ao estado inicial vazio.
- Resultado: PASS, `attempted=true`, `restored=true`, `writes=2` (criação e restauração da fixture, não limpeza do produto).

Isso comprova preservação por não mutação. **Não comprova remoção seletiva**, nem preservação de reservas/bloqueios preexistentes durante um PUT. A primeira tentativa desta rodada abortou antes da escrita externa por indisponibilidade momentânea do PostgreSQL; a repetição com banco pronto passou.

## Publicação e próximos passos

Publicar somente após revisão/aceite da limitação de limpeza suspensa e dos controles operacionais de publicação. Nenhuma autorização de push/deploy foi inferida. Reverter código não recria horários apagados por versões anteriores.

Skills tdd-workflow e verification-loop orientaram os testes e checkpoints; docker-patterns orientou reutilização exclusiva do banco local de fixtures. Context7 não tinha entrada correspondente da API Docplanner; foi consultada a documentação oficial. Graphify e MCP Obsidian indisponíveis; nenhuma nota foi escrita no vault.
