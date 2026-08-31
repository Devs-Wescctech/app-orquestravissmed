# Runbook de preparação — vínculos médicos PUM-only

## 1. Estado e limites desta preparação

Este documento prepara uma remediação futura, mas **não a autoriza nem a
executa**. A autoridade usada pelo fluxo VisMed → Doctoralia é exclusivamente:

`Mapping(clinicId, entityType=DOCTOR, vismedId=VismedDoctor.id, status=LINKED)`
com `externalId` não vazio e correspondente a um `DoctoraliaDoctor` local.

`ProfessionalUnifiedMapping` (PUM) é global e apenas diagnóstico. Ele não
autoriza fallback, não escolhe tenant e não prevalece sobre um mapping clínico.

Limitações desta etapa:

- não houve acesso ao banco real do Portainer; as contagens 11 (8 + 3) e 931
  permanecem baselines históricos a revalidar;
- nenhuma chamada Doctoralia foi realizada;
- nenhum dado, mapping, PUM ou BookingSync foi alterado;
- nenhuma sincronização, recovery, endpoint operacional, deploy, restart,
  commit ou push foi executado;
- não foram lidos ou expostos pacientes, contatos, payloads, credenciais ou URL
  de banco.

## 2. Inventário read-only

Executar no banco-alvo:

`docs/runbooks/sql/audit-pum-only-doctor-mappings.sql`

O arquivo abre `BEGIN TRANSACTION READ ONLY`, aplica timeouts locais, usa apenas
`SELECT`/CTEs e sempre termina em `ROLLBACK`. A saída contém somente IDs
técnicos, estados e contagens.

### 2.1 Definição do conjunto

Cada unidade de decisão é o par **`clinicId + VismedDoctor.id`**, nunca o médico
global isolado. O par entra no inventário quando:

1. a clínica e sua conexão VisMed estão ativas;
2. existe evidência tenant-specific no `BookingSync` ou em `Mapping DOCTOR`;
3. o médico VisMed está ativo;
4. existe PUM ativo;
5. não existe autoridade clínica válida segundo a regra acima.

Essa definição evita o produto cartesiano “todo PUM × toda clínica”. Também
significa que um médico sem qualquer evidência tenant-specific não pode ser
atribuído a uma clínica por inferência; esse caso exige investigação separada.

### 2.2 Saídas e interpretação

- `mapping_*`: estado clínico atual, inclusive ausente, não-LINKED ou externo
  inválido;
- `active_pum_ids` e `pum_candidate_ids`: candidatos históricos auxiliares;
- facilities: somente **contagens históricas diagnósticas**;
- BookingSync: total, últimos 30 dias, futuros ativos, pendentes/falhos de
  origem VisMed criados nos últimos 30 dias, origem VisMed e IDs fora dos
  candidatos PUM ativos;
- `MULTI_CLINIC_REQUIRES_TENANT_VALIDATION`: o mesmo `VismedDoctor.id` tem
  evidência em mais de uma clínica. Cada tenant deve ser validado
  independentemente e pode terminar com Doctoralia doctor IDs diferentes;
- `MULTIPLE_PUMS_DIAGNOSTIC_RISK`: risco que exige revisão, não ambiguidade por
  si só.

Q2 compara o estado encontrado ao baseline histórico:

| clinicId | médicos distintos esperados |
|---|---:|
| `37baa82a-e625-4a1b-ae1d-158ad75037f1` | 8 |
| `e87ca02e-1f7a-4217-92bb-4572069dbf31` | 3 |
| total distinto entre as duas clínicas | 11 |

O SQL nunca completa ou corta resultados para reproduzir o baseline. Qualquer
`STATE_CHANGED_SINCE_BASELINE` é alteração de estado entre auditorias e bloqueia
o gate até ser explicada.

Q3 destaca especificamente o profissional VisMed **6906** na clínica
`e87ca02e-1f7a-4217-92bb-4572069dbf31`. Zero linhas significa estado alterado,
ausência de PUM ativo ou autoridade clínica já válida — nunca “aprovação”.

Q4 emite o manifesto técnico individual da coorte histórica potencialmente
contaminada. Um BookingSync entra somente quando:

1. `origin = VISMED`;
2. `vismedDoctorId` e `doctoraliaDoctorId` armazenados não são nulos;
3. não existe autoridade clínica atual válida para o par
   `clinicId + vismedDoctorId`; **ou**
4. existe autoridade clínica `DOCTOR + LINKED` válida, mas o
   `doctoraliaDoctorId` armazenado diverge de todos os IDs atualmente
   autorizados para esse par.

Q5 repete exatamente essa definição canônica para resumir a mesma coorte. As
CTEs precisam ser repetidas porque seu escopo PostgreSQL termina em cada
instrução; nenhuma view ou tabela temporária é criada. Antes de qualquer
correção futura, a saída integral da Q4 deve ser salva com timestamp, número de
linhas e SHA-256. Esse arquivo é a identidade imutável do lote histórico e não
poderá ser reconstruído depois pela condição corrente dos mappings.

A coorte histórica não depende de a clínica ou sua conexão VisMed permanecerem
ativas no momento da auditoria. Esse gate pertence ao inventário atual Q1–Q3,
não à preservação dos BookingSync históricos.

A coorte é exclusivamente um insumo de **triagem**. Pertencer a ela não autoriza
alteração de Mapping, PUM ou BookingSync e não autoriza reprocessamento.

## 3. Regra de candidato e ambiguidade

O candidato só se torna atual após validação remota tenant-safe:

- **UNIQUE_CURRENT:** exatamente um médico nas facilities atualmente acessíveis
  pela conexão daquela clínica casa por identificador profissional forte;
- **NO_CURRENT_CANDIDATE:** zero correspondências fortes; falhar fechado;
- **AMBIGUOUS_WITHIN_CLINIC:** duas ou mais correspondências fortes dentro da
  mesma clínica; falhar fechado;
- **MULTI_CLINIC_REQUIRES_TENANT_VALIDATION:** o médico aparece em mais de um
  tenant; repetir a validação por clínica. Isso não proíbe IDs Doctoralia
  diferentes por clínica.

Múltiplos PUMs, nomes parecidos, facility histórica, endereço histórico ou
quantidade de bookings **não criam nem resolvem ambiguidade**. Um único candidato
atual confirmado por identificador forte dentro do tenant pode prevalecer sobre
PUMs históricos divergentes, desde que o impacto global desses PUMs seja
fotografado e revisado.

## 4. Validação Doctoralia tenant-safe

Esta seção é um roteiro para uma janela futura autorizada. Não foi executada.

### 4.1 Preparação

1. Congele o resultado do inventário e seu timestamp.
2. Agrupe os pares por `clinicId`.
3. Use somente a conexão Doctoralia da própria clínica.
4. Normalize o registro VisMed e os `license_numbers` Doctoralia com as mesmas
   regras do código: conselho, UF quando presente e número apenas em dígitos sem
   zeros à esquerda.
5. CPF, nome, endereço e facility histórica não são autoridade. Outro
   identificador forte só pode ser aceito se for estável, profissional,
   documentado nos dois sistemas e aprovado previamente.

### 4.2 Chamadas permitidas e teto

Para cada clínica:

1. fazer **uma** leitura de facilities atualmente acessíveis;
2. para cada facility retornada, fazer no máximo **uma** leitura de médicos com
   `doctor.license_numbers`;
3. deduplicar respostas por Doctoralia doctor ID antes do matching;
4. não consultar endereços, serviços, calendário ou bookings.

Se `C` é o número de clínicas e `F_c` o número de facilities atualmente
retornado para a clínica `c`, o teto é:

`GET_max = C + Σ F_c`

Para o baseline de duas clínicas: `GET_max = 2 + F_1 + F_2`. O operador deve
registrar `F_1` e `F_2` antes das leituras de médicos e abortar se o total
projetado exceder o orçamento reservado na janela. Cada endpoint lógico pode ser
lido uma única vez; paginação, se exigida pelo contrato da API, deve ser
contabilizada antecipadamente como GET adicional e revisada no orçamento.

Falha, timeout, resposta parcial, paginação desconhecida, facility zero,
identificador ausente, zero candidatos ou múltiplos candidatos fortes =
**falhar fechado**. Não recorrer a cache local ou PUM para preencher a lacuna.

### 4.3 Colisão tenant-specific

Antes de propor um mapping, confirmar dentro da mesma clínica:

- nenhum outro `Mapping DOCTOR LINKED` usa o candidato para outro médico VisMed;
- não existe mapping concorrente para o mesmo par clínico;
- o candidato ainda pertence a uma facility retornada pela leitura atual;
- a validação forte permanece única após deduplicação.

Colisão ou corrida de estado bloqueia o par, sem bloquear automaticamente pares
independentes já validados.

## 5. Gate de autorização para uma correção futura

Um par só recebe `APPROVED_FOR_SEPARATE_CHANGE` quando todas as evidências abaixo
estiverem anexadas:

- [ ] inventário read-only reexecutado imediatamente antes da decisão;
- [ ] baseline 11 = 8 + 3 conferido ou divergência explicada e reprovada por
      revisão humana;
- [ ] candidato `UNIQUE_CURRENT` dentro da clínica;
- [ ] facility consta na lista atualmente acessível pela mesma conexão;
- [ ] conselho + número e UF, quando disponível, são compatíveis;
- [ ] nenhuma decisão depende de nome, endereço ou facility histórica;
- [ ] ausência de colisão no tenant e de mudança concorrente;
- [ ] todos os PUMs ativos/históricos do médico e seu impacto global revisados;
- [ ] médicos multi-clínica têm evidência independente por tenant;
- [ ] snapshot pré-mudança completo revisado;
- [ ] manifesto técnico BookingSync da Q4 salvo com timestamp, contagem e
      checksum;
- [ ] rollback do par foi revisado e testado em ambiente não produtivo;
- [ ] os 931 BookingSync estão excluídos da primeira mudança;
- [ ] orçamento e evidência das GETs estão completos;
- [ ] autorização humana explícita para uma intervenção separada.

Qualquer caixa vazia = **BLOCKED / NO CHANGE**.

## 6. Modelo de dry-run não executável

O bloco abaixo é um formulário de evidência. Não é SQL e não deve ser convertido
automaticamente em comando:

```text
DRY_RUN_ID:
captured_at:
clinic_id:
vismed_doctor_uuid:
vismed_professional_id:
tenant_scope_class:

CURRENT_MAPPING
  mapping_id:
  entity_type:
  status:
  external_id:
  updated_at:

ACTIVE_PUM_SNAPSHOT
  pum_ids:
  doctoralia_candidate_ids:
  active_count:
  distinct_candidate_count:
  cross_tenant_impact_review:

CURRENT_TENANT_EVIDENCE
  accessible_facility_ids:
  doctoralia_candidate_id:
  strong_identifier_kind:
  normalized_identifier_match: PASS | FAIL
  unique_within_clinic: PASS | FAIL
  collision_check: PASS | FAIL
  api_get_count:
  api_get_budget:

PROPOSED_MAPPING
  mapping_id_strategy: preserve-existing | create-separately-after-authorization
  proposed_status: LINKED
  proposed_external_id:
  justification:

PRE_VALIDATIONS:
POST_VALIDATIONS:
BOOKING_SYNC_ACTION: NONE — HISTORICAL BATCH EXCLUDED

ROLLBACK_PLAN
  restore_mapping_to_exact_snapshot:
  pum_action: NONE unless separately authorized
  verification:
  human_restore_gate:

DECISION: BLOCKED | APPROVED_FOR_SEPARATE_CHANGE
reviewer:
authorization_reference:
```

O dry-run deve mostrar valores atuais e propostos, mas não pode conter
`INSERT`, `UPDATE`, `DELETE`, `UPSERT`, DDL, comandos de sync ou endpoints de
mutação.

## 7. Lote separado para os 931 BookingSync históricos

O baseline de **931** se refere exclusivamente à coorte estrita da seção 2.2:
BookingSync de origem VisMed, com os dois IDs médicos armazenados e sem
autoridade clínica atual válida ou divergente dela. É um baseline de registros
potencialmente contaminados, não uma afirmação de que todos estão errados.
Esses registros ficam explicitamente fora da primeira correção de mappings
ativos.

Depois que os mappings clínicos forem corrigidos e estabilizados, abrir uma
janela e autorização próprias para:

1. carregar como entrada somente os `booking_sync_id` do manifesto Q4
   preservado antes da mudança e verificar seu checksum;
2. confirmar read-only quantos IDs do manifesto continuam presentes; qualquer
   ausência ou ID extra bloqueia o lote;
3. registrar a comparação entre o tamanho imutável do manifesto e o baseline
   histórico 931, sem completar ou cortar o conjunto;
4. particionar por clínica, médico, motivo da inclusão, `status` e
   futuro/passado; `origin = VISMED` e a presença dos dois IDs médicos já são
   invariantes de entrada da coorte;
5. classificar:
   - `CONSISTENT_NO_ACTION`;
   - `HISTORICAL_TERMINAL_RETAIN`;
   - `FUTURE_REQUIRES_MANUAL_REVIEW`;
   - `WRONG_TENANT_OR_DOCTOR_BLOCKED`;
   - `SAFE_REPROCESS_CANDIDATE`;
6. excluir inicialmente `CANCELLED`, `NO_SHOW` e demais terminais de qualquer
   reprocessamento automático;
7. para futuros/ativos, confirmar estado nos dois sistemas e proteção contra
   duplicação antes de considerar reprocessamento;
8. usar lotes pequenos, idempotência, snapshot, orçamento Doctoralia separado,
   validação pós-lote e gate de rollback próprio.

Não copiar IDs do mapping para BookingSync por inferência. Não cancelar, mover,
criar booking ou break como parte da remediação dos mappings.

## 8. Critério de encerramento desta preparação

Esta preparação termina com documentação e SQL read-only revisados. A execução
do SQL no Portainer, a validação Doctoralia e qualquer correção são intervenções
futuras separadas. O estado desta etapa é **PREPARED, NOT EXECUTED**.