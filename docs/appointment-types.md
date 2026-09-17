# Classificação de atendimentos VissMed

Contrato confirmado em 17/09/2026 por leituras HTTP 200, sem consumir o feed:

- GET /api/v1.0/get-agendamento-by-id?idagendamento=<id>: retorna tipo_servico e mostrarnadoctoralia, inclusive profissional desabilitado.
- GET /api/v1.0/get-agendamento-filtros?unidade=<id>&dataini=DD/MM/AAAA&datafim=DD/MM/AAAA: retorna tipo_servico. A habilitação não veio nos itens observados; segundo o fornecedor, a listagem filtra profissionais habilitados. Não adicionar sincronizar=1 em diagnósticos: esse parâmetro consome o feed.

O payload original já é persistido em BookingSync.rawPayload na importação. Não há migration ou backfill neste pacote. Consulta, Exame e Procedimento são normalizados; ausência/valor desconhecido permanece null. Não inferir nome ou código de exame a partir da categoria.

GET /api/booking-sync/records mantém autenticação e autorização por clínica, filtros e formato de lista existentes. Acrescenta appointmentType (Consulta | Exame | Procedimento | null) e professionalDoctoraliaEnabled (boolean | null), derivados do payload persistido. Não consulta integrações nem altera registros durante a leitura. Estados antigos continuam Tipo não informado até receberem novo payload; não há atualização retroativa automática.

Exemplo aditivo: { "appointmentType": "Exame", "professionalDoctoraliaEnabled": false }.

Na ingestão, flag explícita 0, "0" ou false impede propagação automática para Doctoralia. A rotina de bloqueios também verifica o payload persistido antes de operar. A ausência do campo não equivale à desabilitação, preservando o contrato da listagem e das outras instâncias. Esta proteção não descobre desabilitações que a origem deixou de enviar: não é um monitor ativo de profissionais.

Não cancela agendamentos por desabilitação, não remove bloqueios históricos e não agrupa IDs por coincidência de paciente/horário. Qualquer saneamento histórico exige investigação própria. A flag de habilitação não é filtro de exame: exames de profissionais autorizados continuam ocupando a agenda.

Compatibilidade: sem mudanças em schema, dependências, boot ou configuração. A versão anterior lê o mesmo rawPayload; retornar o código não desfaz operações das integrações. Publicação exige identificar e preservar a imagem efetivamente em execução e procedimento limitado ao serviço vismed conforme PUBLICACAO.md.

## Verificação local — 17/09/2026

Base remota conferida: 37222186b7fd41f59278cb4918e4129c7ae53ae4. Ambiente isolado instalado com npm ci e cliente Prisma gerado a partir do schema existente.

- API: 144 testes aprovados em cinco suites (metadados, autoridade por clínica, deduplicação de bloqueios e feed).
- Frontend: 22 testes de regressão existentes aprovados; tsc --noEmit aprovado.
- Builds da API e web concluídos. O Next informou falha ao tentar corrigir dependências SWC no lockfile, mas compilou e gerou as 19 páginas com saída zero. Lockfile não alterado; atualização de dependências fora deste pacote.
- Sem teste visual autenticado ou validação pós-deploy nesta etapa. A publicação está pendente de acesso autenticado ao Portainer e conferência atual dos controles de implantação. Não houve push, deploy, backfill ou alteração de agendamentos reais.
