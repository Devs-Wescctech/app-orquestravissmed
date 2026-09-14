# Conferência de bloqueios na agenda

## Contrato

`GET /booking-sync/records/:id/conflict-details?clinicId=<uuid>`

Autenticação JWT; exige acesso à clínica ou SUPER_ADMIN. O registro também é
consultado pelo par ID/clínica, retornando 404 quando não pertence ao escopo.
Sem body. Sem escrita de agendamentos, associações, banco ou disparo de sync.

Resposta 200 (exemplo fictício):

```json
{
  "checkedAt": "2026-09-14T15:00:00.000Z",
  "availability": "complete",
  "overlaps": [{
    "startAt": "2026-09-15T07:30:00-03:00",
    "endAt": "2026-09-15T07:40:00-03:00",
    "relatedBookings": [{
      "id": "registro-ficticio", "patientName": "Paciente fictício",
      "startAt": "2026-09-15T10:30:00Z", "endAt": "2026-09-15T10:40:00Z",
      "status": "BOOKED", "synchronized": true
    }]
  }],
  "sameNameBookings": []
}
```

`availability`: `complete`, `partial` (provedor indica próxima página/mais itens)
ou `unavailable` (falha, configuração insuficiente ou resposta inválida).
`reason` contém explicação segura quando indisponível; não retorna credenciais,
payload bruto nem erro upstream. 401 sem autenticação, 403 sem clínica/acesso,
404 para registro fora do escopo; falhas inesperadas de banco seguem o tratamento
500 da aplicação. Não há paginação própria: associações dos bloqueios retornados
são listadas; a ausência em consulta parcial não comprova ausência de bloqueios.

## Regras de evidência

- Consulta Doctoralia pelo cliente e limitadores existentes, na janela do dia do
  agendamento em Brasília (estendida ao fim da consulta se atravessar o dia).
  Uma ausência nessa janela não prova ausência global nem resolução da pendência.
- Só aceita endereço persistido ou um único endereço identificado pelos vínculos
  LINKED da mesma clínica/profissional. Não escolhe arbitrariamente um endereço.
- Sobreposição exige interseção real; intervalos adjacentes não contam.
- Associações locais usam clínica, estabelecimento, médico, endereço e ID de
  bloqueio. Excluem o registro investigado. Cancelados são incluídos e identificados,
  pois a associação persistida ainda é relevante para a conferência.
- Registros semelhantes exigem mesmo nome/sobrenome, profissional e intervalo,
  com IDs VissMed presentes e diferentes. Isso não prova duplicidade de pacientes.
- Contagens são de registros locais, não de pacientes distintos nem capacidade.
- A consulta não é uma transação entre sistemas. `checkedAt` informa seu início;
  dados podem mudar depois. Não autoriza liberação, movimentação ou cancelamento.

## Interface e impacto

A lista de conferências carrega detalhes sequencialmente para conflitos presentes
nos registros da agenda; troca de clínica/consulta cancela leituras pendentes e
descarta respostas antigas. Atualizar a agenda refaz a conferência. O modal mostra
intervalos, associações, registros semelhantes, horário da consulta e uma seção
expandível de agendamentos relacionados. Nenhuma notificação é enviada ao paciente.

Sem migração, mudança de schema ou nova dependência. A publicação exige frontend
e API juntos; frontend diante de API antiga mostra indisponibilidade, sem inventar
diagnóstico. Leituras adicionais podem aumentar uso da API Doctoralia conforme o
número de conflitos; a fila e os limites existentes permanecem ativos.

## Validação

- API: `booking-conflicts.service.spec.ts` — escopo, autorização, associações,
  interseção, registros semelhantes, endereço ambíguo, falhas e paginação.
- Interface: `node --test scripts/booking-conflict-details.test.cjs` — textos,
  intervalos, quantidades, horários e estados sem evidência suficiente.
- Build da API e frontend; checagem TypeScript do frontend.
- Integrações simuladas nos testes; não cria nem modifica consultas reais.

Resultados locais em 14/09/2026: 14 testes de serviço/controlador/contrato HTTP,
5 testes da apresentação e 12 testes de regressão dos estados da agenda aprovados.
TypeScript do frontend e build da API aprovados. A chamada de leitura da Doctoralia
foi conferida no formato com offset `-03:00`; o retorno da janela tinha 11 intervalos
válidos, sem próxima página. Não foram gravados dados de pacientes neste documento.
O resolver nativo do Jest falhou neste Windows; a execução utilizou resolução Node
com suporte às extensões TS, mantendo Jest, ts-jest e as asserções originais.
O build do frontend mantém o aviso preexistente de SWC/lockfile; dependências não
foram alteradas. Verificação visual interativa e publicação em produção não fazem
parte desta validação local.
