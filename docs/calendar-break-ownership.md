# Evidência de criação dos bloqueios de agendamentos

## Comportamento

Agendamentos com origem VISMED criam bloqueios (breaks), não consultas com pacientes, na Doctoralia. Horários coincidentes não identificam o proprietário de um bloqueio. A recuperação por comparação de since/till foi retirada deste fluxo.

Antes de POST, uma entrada de controle em AuditLog registra a tentativa com chave primária calendar-break:<BookingSync.id>. Só a resposta direta com ID válido permite gravar o comprovante OWNED e associar o bloqueio. O comprovante inclui clínica, estabelecimento, médico, endereço e ID remoto, sem dados do paciente ou credenciais.

- 409: registra BREAK_CONFLICT, mantém syncedToDoctoralia=false e não adota bloqueio remoto.
- Timeout, rede, HTTP 5xx, resposta sem ID ou falha ao salvar o comprovante: a tentativa PENDING persiste. Novos polls não repetem POST até conferência operacional.
- Falha comprovadamente anterior ao envio ou rejeição HTTP 4xx: libera a tentativa para retry; não declara sucesso.
- Falha no update de BookingSync depois de salvar o comprovante: recupera exclusivamente o ID comprovado, deixa sincronização pendente e confere/move o horário no poll seguinte.
- PATCH/DELETE de vínculos com comprovante exigem o mesmo escopo e ausência de outro agendamento associado ao mesmo ID. Inclui cancelamento pelo dashboard.
- Transição aprovada em 13/09: IDs já associados ao BookingSync e sem entrada de comprovante mantêm o ciclo existente de reagendamento/cancelamento. Ausência do novo comprovante não implica erro nem impõe conferência pelas clínicas. Essa exceção não certifica a origem histórica: a investigação dos vínculos antigos permanece separada.
- A exceção não se aplica ao caminho de associação de IDs novos, nem a comprovantes PENDING, inconsistentes ou de outro escopo. Associação duplicada a outro BookingSync continua impedindo a operação e exige investigação interna.

## Banco e retorno

Sem alteração de schema, migration, dependências ou configuração. Usa a chave primária existente de AuditLog para busca e exclusão específicas, além dos campos já existentes doctoraliaBreakId/syncedToDoctoralia/syncError. Não executar limpeza dessa entrada operacional como descarte genérico de logs: isso elimina a evidência e pode fazer um vínculo novo ser tratado como legado.

A versão anterior consegue ler o banco, mas ignora o comprovante e volta a permitir a adoção por horário. Retorno de imagem não desfaz bloqueios criados nem restaura proteção lógica. Não há migração automática das associações antigas nem correção de dados em produção neste pacote.

Conferência operacional de PENDING/legado exige evidência da operação original ou investigação específica; nunca certificar apenas porque existe um bloqueio no mesmo horário. Não apagar a tentativa para forçar retry sem confirmar que a criação anterior não aconteceu.

## Escopo e validação

O fluxo de bloqueios administrativos AdminBlockBreak é separado e não foi ativado ou modificado neste pacote. Não afirmar que sua reconciliação por horário foi corrigida por esta entrega.

Validação da transição em 13/09: 40 testes específicos de bloqueios passaram, cobrindo também cancelamento/reagendamento do legado e impedimento de usar a exceção para IDs novos ou comprovantes inconsistentes. Regressão conjunta: 9 suítes/294 testes passaram (incluem os 40), abrangendo ingestão Doctoralia, origem/escopo VISSMED e disponibilidade. Testes usam APIs simuladas; não houve criação ou cancelamento de consultas reais.

Web permanece sem mudanças nesta transição; os 16 testes e o build do pacote anterior continuam registrados. A imagem ac06ff9 é anterior à transição e não deve ser publicada como se contivesse a exceção para vínculos antigos.

Integra os quatro ajustes de diagnóstico de agendas documentados em empty-agendas-diagnostics.md. Publicação e imagem devem ser registradas no documento operacional somente após execução verificada.
