# WP-01 — Inventário Estático de Chamadas à API Doctoralia

> **Gerado em:** 2026-08-08  
> **Propósito:** Inventário estático de todas as origens de chamadas à API Doctoralia
> no `app-orquestravissmed`. Serve como referência para análise de consumo (baseline).

## Legenda

| Campo | Descrição |
|---|---|
| Serviço | Classe NestJS ou arquivo de origem |
| Método | Método/função que gera a chamada |
| Operação | Nome lógico da chamada (correlacionado com `DoctoraliaMetricsService`) |
| Endpoint (sanitizado) | Path com IDs substituídos por `:id` |
| HTTP | Verbo HTTP |
| Origem | Enum `DoctoraliaOrigin` propagado pelo `AsyncLocalStorage` |
| Frequência | Estimativa de frequência em condições normais |
| Retry | Se a chamada pode ser repetida automaticamente em caso de 401 |
| Prioridade | `HIGH` (fila prioritária) / `LOW` (fila normal) |
| Paralelismo | Se múltiplas instâncias podem rodar simultaneamente |

---

## 1. Polling de Notificações — `BookingSyncService`

| # | Serviço | Método | Operação | Endpoint | HTTP | Origem | Frequência | Retry | Prioridade | Paralelismo |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `BookingSyncService` | `pollClinic` | `GET_NOTIFICATIONS` | `/api/v3/integration/notifications/multiple?limit=100` | GET | POLLING | ~a cada 30–34s por clínica | Sim (401) | LOW | Por clínica (staggered) |
| 2 | `BookingSyncService` | `pollClinic` | `RELEASE_NOTIFICATIONS` | `/api/v3/integration/notifications/release` | POST | POLLING | Condicional (só se há notificações falhas) | Sim | LOW | Por clínica |

---

## 2. Reconciliações — `BookingSyncService`

Todas as reconciliações são disparadas dentro do ciclo de polling VisMed (`pollVismedClinic`), com origem `RECONCILIATION`.

| # | Serviço | Método | Operação | Endpoint | HTTP | Origem | Frequência | Retry | Prioridade | Paralelismo |
|---|---|---|---|---|---|---|---|---|---|---|
| 3 | `BookingSyncService` | `reconcileUnlinkedWithDoctoralia` | `GET_BOOKINGS` | `/api/v3/integration/facilities/:id/doctors/:id/addresses/:id/bookings` | GET | RECONCILIATION | A cada poll VisMed (~30s) × bookings UNLINKED | Sim | LOW | Por clínica |
| 4 | `BookingSyncService` | `reconcileUnlinkedWithDoctoralia` | `CANCEL_BOOKING` | `/api/v3/integration/facilities/:id/doctors/:id/addresses/:id/bookings/:id` | DELETE | RECONCILIATION | Condicional (booking cancelado no Doctoralia) | Sim | LOW | Por clínica |
| 5 | `BookingSyncService` | `reconcileCancelledOnDoctoralia` | `GET_BOOKINGS` | `/api/v3/integration/facilities/:id/doctors/:id/addresses/:id/bookings` | GET | RECONCILIATION | A cada poll VisMed × bookings BOOKED com doctoraliaBookingId | Sim | LOW | Por clínica |
| 6 | `BookingSyncService` | `propagateVismedCancellationToDoctoralia` | `CANCEL_BOOKING` | `/api/v3/integration/facilities/:id/doctors/:id/addresses/:id/bookings/:id` | DELETE | RECONCILIATION | Condicional (agendamento desapareceu da VisMed) | Sim | LOW | Por clínica |
| 7 | `BookingSyncService` | `syncDoctoraliaBreak` | `ADD_BREAK` | `/api/v3/integration/facilities/:id/doctors/:id/addresses/:id/breaks` | POST | RECONCILIATION | Condicional (origin=VISMED, status=BOOKED) | Sim | LOW | Por clínica |
| 8 | `BookingSyncService` | `syncDoctoraliaBreak` | `DELETE_BREAK` | `/api/v3/integration/facilities/:id/doctors/:id/addresses/:id/breaks/:id` | DELETE | RECONCILIATION | Condicional (status=CANCELLED ou BOOKED com breakId) | Sim | LOW | Por clínica |
| 9 | `BookingSyncService` | `syncDoctoraliaBreak` | `MOVE_BREAK` | `/api/v3/integration/facilities/:id/doctors/:id/addresses/:id/breaks/:id` | PATCH | RECONCILIATION | Condicional (remarcação origin=VISMED) | Sim | LOW | Por clínica |
| 10 | `BookingSyncService` | `syncDoctoraliaBreak` | `GET_BREAKS` | `/api/v3/integration/facilities/:id/doctors/:id/addresses/:id/breaks` | GET | RECONCILIATION | Condicional (para localizar break existente) | Sim | LOW | Por clínica |

---

## 3. Tratamento de Webhooks — `BookingSyncService`

| # | Serviço | Método | Operação | Endpoint | HTTP | Origem | Frequência | Retry | Prioridade | Paralelismo |
|---|---|---|---|---|---|---|---|---|---|---|
| 11 | `BookingSyncService` | `handleSlotBooked` → `bookOnDoctoraliaFromVismed` | `BOOK_SLOT` | `/api/v3/integration/facilities/:id/doctors/:id/addresses/:id/slots/:id/book` | POST | WEBHOOK | Por evento slot-booked recebido | Não (fila com retry) | LOW | Paralelo (por clínica) |
| 12 | `BookingSyncService` | `handleBookingCanceled` | `CANCEL_BOOKING` | `/api/v3/integration/facilities/:id/doctors/:id/addresses/:id/bookings/:id` | DELETE | WEBHOOK | Por evento booking-canceled | Não (fila) | LOW | Paralelo |
| 13 | `BookingSyncService` | `handleBookingMoved` | `GET_BOOKINGS` + `MOVE_BOOKING` | `/api/v3/integration/facilities/:id/doctors/:id/addresses/:id/bookings/:id/move` | POST | WEBHOOK | Por evento booking-moved | Não (fila) | LOW | Paralelo |

---

## 4. Safety Sweep — `BookingSafetySweepService`

| # | Serviço | Método | Operação | Endpoint | HTTP | Origem | Frequência | Retry | Prioridade | Paralelismo |
|---|---|---|---|---|---|---|---|---|---|---|
| 14 | `BookingSafetySweepService` | `sweepClinic` | `GET_BOOKINGS` | `/api/v3/integration/facilities/:id/doctors/:id/addresses/:id/bookings` | GET | SAFETY_SWEEP | A cada 20min (BOOKING_SWEEP_INTERVAL_MIN) × pares médico/endereço | Sim | HIGH | Por clínica (sequencial) |
| 15 | `BookingSafetySweepService` | `fetchBookingDetail` | `GET_BOOKINGS` (detalhe) | `/api/v3/integration/facilities/:id/doctors/:id/addresses/:id/bookings/:id` | GET | SAFETY_SWEEP | Condicional (booking sem nome do paciente) | Sim | HIGH | Por booking |

---

## 5. Slot Sync — `SlotSyncService`

| # | Serviço | Método | Operação | Endpoint | HTTP | Origem | Frequência | Retry | Prioridade | Paralelismo |
|---|---|---|---|---|---|---|---|---|---|---|
| 16 | `SlotSyncService` | `syncSlotsForDoctor` | `GET_ADDRESSES` | `/api/v3/integration/facilities/:id/doctors/:id/addresses` | GET | SLOT_SYNC | A cada sync global (30min) × médico vinculado | Sim | LOW | Por médico |
| 17 | `SlotSyncService` | `syncSlotsForDoctor` | `GET_SERVICES` | `/api/v3/integration/facilities/:id/doctors/:id/addresses/:id/services` | GET | SLOT_SYNC | A cada sync × endereço do médico | Sim | LOW | Por endereço |
| 18 | `SlotSyncService` | `syncSlotsForDoctor` | `ENABLE_CALENDAR` | `/api/v3/integration/facilities/:id/doctors/:id/addresses/:id/calendar/enable` | POST | SLOT_SYNC | A cada sync com slots não-vazios (antes do replaceSlots) | Sim | LOW | Por endereço |
| 19 | `SlotSyncService` | `syncSlotsForDoctor` | `REPLACE_SLOTS` | `/api/v3/integration/facilities/:id/doctors/:id/addresses/:id/slots` | PUT | SLOT_SYNC | A cada sync quando hash diferente (incremental) | Não (sem retry explícito) | LOW | Por endereço |
| 20 | `SlotSyncService` | `syncSlotsForDoctor` | `GET_INSURANCE_PLANS` | `/api/v3/integration/insurance-providers/:id/plans` | GET | SLOT_SYNC | Por provider de convênio (cache por médico) | Sim | LOW | Por provider |
| 21 | `SlotSyncService` | `provisionAddressServices` | `GET_SERVICES` (catalog) | `/api/v3/integration/facilities/:id/services/catalog` | GET | SLOT_SYNC | Condicional (serviço não encontrado no endereço) | Sim | LOW | Por endereço |
| 22 | `SlotSyncService` | `provisionAddressServices` | `ADD_SERVICES` | `/api/v3/integration/facilities/:id/doctors/:id/addresses/:id/services` | POST | SLOT_SYNC | Condicional (auto-provisionamento de serviço) | Sim | LOW | Por serviço |

---

## 6. Block Watcher — `BlockWatcherService`

| # | Serviço | Método | Operação | Endpoint | HTTP | Origem | Frequência | Retry | Prioridade | Paralelismo |
|---|---|---|---|---|---|---|---|---|---|---|
| 23 | `BlockWatcherService` | `watchClinic` → `SlotSyncService.syncSlotsForDoctor` | (ver Slot Sync acima) | (ver acima) | (ver acima) | SLOT_SYNC | A cada 10min quando hash de bloqueio muda | Sim | LOW | Por médico afetado |

---

## 7. Sync Scheduler — `SyncSchedulerService`

| # | Serviço | Método | Operação | Endpoint | HTTP | Origem | Frequência | Retry | Prioridade | Paralelismo |
|---|---|---|---|---|---|---|---|---|---|---|
| 24 | `SyncSchedulerService` | `runGlobalSyncForAllClinics` → `SyncService.triggerGlobalSync` | Todas as operações de sync | (delegadas) | (delegadas) | SCHEDULER | A cada 30min | Depende do sub-serviço | LOW | Por clínica (sequencial) |

---

## 8. UI de Agendamentos — `AppointmentsService` / `AppointmentsController`

| # | Serviço | Método | Operação | Endpoint | HTTP | Origem | Frequência | Retry | Prioridade | Paralelismo |
|---|---|---|---|---|---|---|---|---|---|---|
| 25 | `AppointmentsService` | `getBookings` | `GET_BOOKINGS` | `/api/v3/integration/facilities/:id/doctors/:id/addresses/:id/bookings` | GET | USER_INTERACTIVE | Por request HTTP do painel | Não (direto ao usuário) | HIGH | Por request |
| 26 | `AppointmentsService` | `getAllBookings` | `GET_BOOKINGS` (todos médicos) | `/api/v3/integration/facilities/:id/doctors/:id/addresses/:id/bookings` | GET | USER_INTERACTIVE | Por request HTTP (todos médicos) | Não | HIGH | Por médico |
| 27 | `AppointmentsService` | `getSlots` | `GET_SLOTS` | `/api/v3/integration/facilities/:id/doctors/:id/addresses/:id/slots` | GET | USER_INTERACTIVE | Por request HTTP | Não | HIGH | Por request |
| 28 | `AppointmentsService` | `refreshCalendarStatusInBackground` | `GET_FACILITIES` | `/api/v3/integration/facilities` | GET | USER_INTERACTIVE | Por abertura do painel (background) | Sim | HIGH | Por clínica |
| 29 | `AppointmentsService` | `enrichDoctorData` | `GET_ADDRESSES` | `/api/v3/integration/facilities/:id/doctors/:id/addresses` | GET | USER_INTERACTIVE | Condicional (dados incompletos no banco) | Sim | HIGH | Por médico |
| 30 | `AppointmentsService` | `refreshCalendarStatus` | `GET_CALENDAR` | `/api/v3/integration/facilities/:id/doctors/:id/addresses/:id/calendar` | GET | USER_INTERACTIVE | Condicional (status desconhecido) | Sim | HIGH | Por médico |
| 31 | `AppointmentsService` | `updateCalendarStatus` | `ENABLE_CALENDAR` / `DISABLE_CALENDAR` | `/api/v3/integration/facilities/:id/doctors/:id/addresses/:id/calendar/enable` | POST | USER_INTERACTIVE | Por ação do usuário no painel | Não | HIGH | Por request |
| 32 | `AppointmentsService` | `replaceSlots` | `REPLACE_SLOTS` | `/api/v3/integration/facilities/:id/doctors/:id/addresses/:id/slots` | PUT | USER_INTERACTIVE | Por ação do usuário no painel | Não | HIGH | Por request |
| 33 | `AppointmentsService` | `bookSlot` | `BOOK_SLOT` | `/api/v3/integration/facilities/:id/doctors/:id/addresses/:id/slots/:id/book` | POST | USER_INTERACTIVE | Por ação do usuário no painel | Não | HIGH | Por request |
| 34 | `AppointmentsService` | `deleteSlots` | `DELETE_SLOTS` | `/api/v3/integration/facilities/:id/doctors/:id/addresses/:id/slots/:id` | DELETE | USER_INTERACTIVE | Por ação do usuário no painel | Não | HIGH | Por request |

---

## 9. Autenticação OAuth — `DocplannerClient`

| # | Serviço | Método | Operação | Endpoint | HTTP | Origem | Frequência | Retry | Prioridade | Paralelismo |
|---|---|---|---|---|---|---|---|---|---|---|
| 35 | `DocplannerClient` | `fetchNewToken` | `OAUTH_TOKEN` | `/oauth/v2/token` | POST | AUTHENTICATION | ~a cada 50min (cache ~1h); dedupado com `inflightAuth` | Não (exceção propagada) | LOW | Dedupado (uma chamada por cacheKey) |
| 36 | `TokenRefresherService` | `refreshTokensProactively` | `OAUTH_TOKEN` | `/oauth/v2/token` | POST | AUTHENTICATION | A cada 55min (renovação proativa, antes de expirar) | Sim | LOW | Por conexão |

---

## 10. Resumo de Contagens Esperadas (estimativa em regime normal, 1 clínica com 5 médicos)

| Janela | Origem | Estimativa de Chamadas |
|---|---|---|
| 5 min | AUTHENTICATION | ~0–1 (token em cache) |
| 5 min | POLLING | ~10 (notificações, a cada 30s) |
| 5 min | RECONCILIATION | ~30–60 (bookings verificados por poll) |
| 5 min | SAFETY_SWEEP | ~10–25 (1 sweep × 5 médicos × 1–5 endereços) |
| 5 min | SLOT_SYNC | ~15–30 (incremental; maioria `SLOT_SYNC_SKIPPED_UNCHANGED`) |
| 5 min | USER_INTERACTIVE | Variável (depende do uso do painel) |
| **Total** | **Todas** | **~65–130 / 5min** (< 400/5min = limite WAF) |

---

## Observações

1. **Rate limit global**: 400 req/5min (WAF Doctoralia). Duas filas: HIGH (varredura + UI) e LOW (sync em massa).
2. **Token OAuth**: cache global ~1h; a mesma instância usa um único token por domínio/clientId.
3. **Retry automático**: `DocplannerClient.request()` renova token e repete UMA vez em caso de 401.
4. **Incremental (SLOT_SYNC)**: `SlotPushState` previne replaceSlots redundante; a maioria dos ciclos emite `SLOT_SYNC_SKIPPED_UNCHANGED`.
5. **Deduplicação de OAuth**: `inflightAuth` garante que chamadas concorrentes aguardem a mesma promise em vez de disparar múltiplos POSTs.
6. **Multi-instância**: sem Redis/banco externo; cada instância tem seu próprio rate limiter e cache em memória. O endpoint `/metrics/doctoralia-baseline` representa apenas a instância que atende a requisição.
