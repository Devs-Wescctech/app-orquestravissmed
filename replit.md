# VisMed Workspace

## Overview
Monorepo da plataforma VisMed — dashboard de agendamento médico e integração que sincroniza
bidirecionalmente a agenda da **VisMed** com a **Doctoralia/Docplanner**.

## Architecture
- **apps/web** — Next.js 14 frontend (porta 5000; proxia `/api/*` para o backend via rewrites em `next.config.js`).
- **apps/api** — NestJS + Prisma ORM + PostgreSQL (porta 3000, **sem** prefixo `/api`).

## Running the App
Workflow `Start application`: `cd apps/api && node dist/main.js & cd apps/web && npm run dev`
- Build da API: `cd apps/api && npx tsc` (saída em `apps/api/dist/`). **Sempre rebuildar após mudar código da API.**
- Package manager: **npm** (workspace monorepo).

## Key APIs
- `POST /api/auth/login` — autenticação JWT
- `GET /api/clinics/my` — clínicas do usuário
- `GET /api/doctors` — médicos sincronizados
- `GET /api/appointments/*` — calendário e bookings
- `GET /api/mappings/*` — gestão de mapeamentos
- `POST /api/sync/:clinicId/*` — gatilhos de sincronização
- `POST /api/webhooks/doctoralia` — push público de notificações Doctoralia

## Database
PostgreSQL do Replit (Prisma). Schema em `apps/api/prisma/schema.prisma`.

## Environment Variables
- `DATABASE_URL` — conexão PostgreSQL (auto-set pelo Replit)
- `JWT_SECRET` — chave de assinatura JWT
- `VISMED_API_PORT` — porta da API (3000)
- `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` — opcionais (BullMQ). Sem Redis, o sync roda inline; erros
  `ECONNREFUSED 6379` nos logs são esperados e não-fatais.
- Kill switches: `DISABLE_SYNC_CRON=true`, `SLOT_SOURCE=template` (modo legado de turnos),
  `SLOT_INSURANCE_MODE` (modo de convênio dos slots).

## Default Credentials
- Email: `admin@vismed.com` · Senha: `admin123`

## Integrations
- **VisMed API**: `idEmpresaGestora` guardado como `clientId` em `IntegrationConnection` (provider `vismed`).
  Base URL default `https://app.vissmed.com.br/api-vissmed-4/api/v1.0`. O serviço auto-prepende `https://` e o
  caminho da API se só o domínio estiver salvo.
- **Doctoralia/Docplanner**: OAuth2 client credentials. Credenciais em `IntegrationConnection` (provider
  `doctoralia`: `clientId`, `clientSecret`, `domain`). `domain` deve incluir `www` (ex.: `www.doctoralia.com.br`).
  ⚠️ Contratos implícitos não-óbvios da página pública (insurance_support, insurance_plans, slot insurance_accepted)
  estão em `.agents/memory/doctoralia-api-gotchas.md` — leia antes de mexer em convênio/slots.
- **Redis/BullMQ**: filas de sync; fallback inline quando indisponível (default no Replit).

## Sync Architecture
`SyncService` orquestra os pipelines (BullMQ primeiro, fallback inline):
1. **VisMed sync** (`vismed-full`): unidades, especialidades, profissionais, convênios → `VismedUnit/Specialty/Doctor/Insurance` + `Mapping`.
2. **Doctoralia sync** (`full`): facilities, doctors, services + dicionários globais de serviços (~10.889) e
   de convênios (2717+) → `DoctoraliaDoctor/Service/AddressService/InsuranceProvider` + `Mapping`. Roda push de volta.
3. **Global** (`/sync/:clinicId/global`): dispara os dois em sequência.
4. **Matching Engine**: auto-casa especialidades↔serviços, médicos↔médicos, convênios↔providers (exato/contains/fuzzy).
- **Auto Sync Scheduler** (`sync-scheduler.service.ts`): `@Cron('*/30 * * * *', America/Sao_Paulo)` dispara o sync
  global de cada clínica ativa a cada 30 min. Roda in-process (não sofre timeout do gateway). Anti-overlap triplo
  (flag global + `SyncRun.status='running'` por clínica + limpeza de lock travado). Failsafe por clínica (try/catch).

## Modules (resumo)
- **Mapping** (`/mappings/*`): dedup de especialidades por `normalizedName`; stats de cobertura; aprovação
  manual de matches. Especialidades: `score≥0.90` auto-aprova, `0.60–0.89` cria com `requiresReview=true`
  (aprovar em `/mapping`), `<0.60` não cria. Push/slot sync usam `requiresReview:false` — pendentes NÃO vão pra
  Doctoralia até aprovados. Convênios: só match exato (100%) auto-linka; resto vai a `PENDING_REVIEW`. Aprovar
  convênio dispara push automático.
- **Turnos / Slots**: `turnoM/T/N` no `VismedDoctor`. `SlotSyncService` empurra work periods via `replaceSlots`
  (PUT que substitui o calendário inteiro do endereço). **Fonte de verdade = `scheduleDay`** (disponibilidade real;
  bloqueio na VisMed faz o horário sumir). Anti-wipe + incremental por hash (`SlotPushState`). Detalhes e limites em
  `.agents/memory/vismed-slot-availability.md` e `vismed-schedule-day-blocks.md`.
- **Bidirectional Booking Sync** (`BookingSyncService`): espelha bookings VisMed↔Doctoralia (slot-booked,
  booking-canceled, booking-moved) via webhook + polling escalonado por clínica. Cancelamento e reagendamento
  bidirecionais com reconciliação ao fim de cada poll e anti-loop/anti-eco. Princípios em
  `.agents/memory/booking-sync-reconciliation.md` e `vismed-cancellation-disappearance.md`.
- **Multi-Tenant Security**: todos os `/sync/:clinicId/*` validam `UserClinicRole` do usuário; médicos são
  escopados à clínica via `Mapping` (`validateDoctorBelongsToClinic` usa `Mapping.vismedId` = UUID do VismedDoctor).
- **Scalability** (30 clínicas × 400 bookings/dia): job queue em PostgreSQL (`SyncJob` + `QueueService`, `FOR UPDATE
  SKIP LOCKED`, backoff exponencial, dead-letter após 5 tentativas); rate limiter token-bucket por provider;
  polling escalonado; dedup por `dedupKey`; webhook exige match exato de facilityId (sem fallback cross-tenant).

## Key Files
- `apps/web/src/lib/api.ts` — HTTP client (via proxy `/api/*`)
- `apps/web/src/lib/store.ts` / `clinic-store.ts` — Zustand (auth + seleção de clínica, com persist)
- `apps/web/next.config.js` — rewrites do proxy da API
- `apps/web/src/middleware.ts` — auth middleware (cookie)
- `apps/api/src/main.ts` / `app.module.ts` — entry point / root module NestJS
- `apps/api/src/sync/` — scheduler, slot-sync, vismed-availability, push-sync, sync.controller
- `apps/api/src/bookings/booking-sync.service.ts` — engine de sync de bookings
- `apps/api/prisma/schema.prisma` — schema do banco

## User Preferences
- **Idioma**: sempre responder em **português do Brasil (pt-BR)**.
- **Memória de detalhes**: lições profundas e gotchas de API externa ficam em `.agents/memory/` (índice em
  `MEMORY.md`); manter o `replit.md` enxuto como README estrutural, não como changelog.
