# VisMed Workspace

## Overview
A monorepo for the VisMed platform — a medical scheduling and integration dashboard.

## Architecture
- **apps/web** — Next.js 14 frontend (port 5000, proxies API calls to backend)
- **apps/api** — NestJS backend with Prisma ORM + PostgreSQL (port 3000)

## How It Runs
The workflow starts both services together:
1. NestJS API on port 3000 (backend)
2. Next.js frontend on port 5000 (serves UI, proxies `/api/*` to backend)

The frontend uses `next.config.js` rewrites to proxy all `/api/*` requests to the NestJS backend transparently.

## Running the App
Workflow: `Start application` → `cd apps/api && node dist/main.js & cd apps/web && npm run dev`

## Key APIs
- `POST /api/auth/login` — JWT authentication
- `GET /api/clinics/my` — User's clinics
- `GET /api/doctors` — Synced doctors
- `GET /api/appointments/*` — Calendar and bookings
- `GET /api/mappings/*` — Data mapping management
- `POST /api/sync/:clinicId/*` — Synchronization triggers

## Database
Replit PostgreSQL (Prisma ORM). Schema in `apps/api/prisma/schema.prisma`.

## Environment Variables
- `DATABASE_URL` — PostgreSQL connection (auto-set by Replit)
- `JWT_SECRET` — JWT signing key
- `VISMED_API_PORT` — API port (3000)
- `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` — Optional, for BullMQ sync queues

## Package Manager
npm (workspace monorepo).

## Build Commands
- API build: `cd apps/api && npx tsc` (outputs to `apps/api/dist/`)
- Web dev: `cd apps/web && npm run dev`

## Integrations
- **VisMed API**: Uses `idEmpresaGestora` (stored as `clientId` in `IntegrationConnection` with provider `vismed`). Default base URL: `https://app.vissmed.com.br/api-vissmed-4/api/v1.0`. The service auto-prepends `https://` and the API path if only a domain is stored.
- **Doctoralia/Docplanner**: OAuth2 client credentials flow. Credentials stored in `IntegrationConnection` with provider `doctoralia` (fields: `clientId`, `clientSecret`, `domain`). Domain must include `www` prefix (e.g., `www.doctoralia.com.br`). Calendar API uses dedicated endpoints: `GET .../calendar` (status), `POST .../calendar/enable`, `POST .../calendar/disable`. The `appointments.service.ts` auto-enriches doctor data (facilityId, addressId) and auto-refreshes calendarStatus from Doctoralia API when local cache is missing/stale, preventing false "disabled" blocks.
- **Redis/BullMQ**: Used for sync job queues. When Redis is unavailable (default in Replit), the `SyncService` falls back to running sync logic directly inline. Redis errors in logs are expected and non-fatal.

## Sync Architecture
The `SyncService` orchestrates two sync pipelines:
1. **VisMed sync** (`vismed-full`): Pulls units, specialties, professionals, and insurances (convênios) from the VisMed API. Creates `VismedUnit`, `VismedSpecialty`, `VismedDoctor`, `VismedInsurance` records and `Mapping` entries.
2. **Doctoralia sync** (`full`): Pulls facilities, doctors, services from Docplanner API. Creates `DoctoraliaDoctor`, `DoctoraliaService`, `DoctoraliaAddressService` records and `Mapping` entries. Fetches the global services dictionary (`GET /api/v3/integration/services`, ~10,889 items) into `DoctoraliaService`, and the global insurance providers dictionary (2717+ items) into `DoctoraliaInsuranceProvider`. Runs push sync back to Doctoralia.
3. **Global sync** (`/sync/:clinicId/global`): Triggers both pipelines in sequence.
4. **Matching Engine**: After sync, auto-matches VisMed specialties to Doctoralia services, VisMed doctors to Doctoralia doctors, and VisMed convênios (insurances) to Doctoralia insurance providers using exact/contains/fuzzy string similarity.

Both pipelines attempt BullMQ queue dispatch first, then fall back to direct inline execution if Redis is unavailable.

## Default Credentials
- Email: `admin@vismed.com`
- Password: `admin123`

## Mapping Module
- **Specialty deduplication**: `getProfessionalMappings` deduplicates specialties per doctor by `normalizedName` to avoid visual duplicates (e.g., "Clinico Geral" vs "Clínico Geral").
- **Insurance enrichment**: `findAll` for INSURANCE mappings now returns `doctoraliaCounterpart` with name/doctoraliaId from `DoctoraliaInsuranceProvider`.
- **Specialty stats**: `GET /mappings/specialties/stats` returns totalVismedSpecialties, totalDoctoraliaServices, totalMatched, totalAutoApproved, totalPendingReview, totalUnmatched, coveragePercent.
- **Manual approval threshold**: Insurance convênios: ONLY exact name match (100%) auto-links. All other matches (contains, token, fuzzy) go to `PENDING_REVIEW` for manual confirmation. Approve/reject via `POST /mappings/insurance/approve` and `/reject` (clinic-scoped). Re-matching skips both LINKED and PENDING_REVIEW entries.
- **Insurance matching engine**: NOISE_WORDS are only grammatical connectives (de, do, da, etc.) — meaningful words like "cartao", "clinica", "unimed" are NOT noise. NON_INSURANCE_PATTERNS skip payment-type entries (orcamento, r$, a vista, parcelado, faturar, particular). Token-based matching uses combined score (60% token overlap + 40% dice similarity). Only exact string match auto-links; contains match goes to PENDING_REVIEW at ~90%, token match at 55%+, fuzzy match at 65%+ (must share at least one core token). Substring matching (≥4 chars) allows "clinica" ⊂ "clinicas". Rescan step auto-cleans false-positive matches when a VisMed insurance name matches NON_INSURANCE_PATTERNS.
- **Insurance auto-push on approval**: When a convênio is approved via `POST /mappings/insurance/approve`, the frontend automatically triggers `POST /sync/:clinicId/insurance` to push all LINKED insurances to all doctors in Doctoralia.
- **Profissionais tab**: Shows sync status indicator (Completo/Parcial/Sem Turnos/Pendente) instead of manual sync button — sync is fully automatic via global pipeline. `calendarStatus` defaults to `'unknown'` (not `'enabled'`) to prevent false "Completo" status. Only set to `'enabled'` after successful slot sync in push-sync. Frontend treats `unknown` as non-complete.
- **Orphan cleanup safety**: `cleanupOrphans` in sync.processor.ts skips orphaning when activeIds is empty (for ALL entity types, not just DOCTOR).

## Turnos (Work Shifts) Module
- **turnoM/T/N fields** on `VismedDoctor`: Stores morning/afternoon/night shift times (e.g. `"08:00 - 12:00"`).
- **Sync paths**: Both `sync.service.ts` (global sync) and `vismed-sync.processor.ts` (queue-based) persist turno data from VisMed API field `turno_m/t/n`.
- **SlotSyncService** (`slot-sync.service.ts`): Converts turnoM/T/N into Doctoralia calendar work periods via `replaceSlots` API. Sends work periods (e.g., 08:00-12:00 with duration=30) and lets Docplanner calculate individual bookable slots — per API docs: "Add work periods, not individual slots". Deduplicates address services by `service_id`. Auto-enables calendar before sending; skips address on 4xx enable failure. `deleteSlots` uses `DELETE .../slots/{date}` (per-date, not range query params). `address_service_id` sent as string per API spec.
- **Calendar Breaks API**: `DocplannerClient` supports `getCalendarBreaks`, `addCalendarBreak`, `moveCalendarBreak`, `deleteCalendarBreak`.
- **Endpoints**: `POST /sync/:clinicId/slots/:vismedDoctorId` (single), `POST /sync/:clinicId/slots` (all), `GET /sync/shifts/:vismedDoctorId`, `POST /sync/:clinicId/calendar/:doctorId/enable|disable`.
- **Push-sync integration**: After services delta sync, automatically syncs insurance providers (step 4) and slots (step 5) for all doctors. Slots are always evaluated — doctors with turnos get slots pushed, doctors without turnos get a skip event logged.
- **Insurance push sync**: Compares LINKED insurance mappings in DB with current providers on Doctoralia per address. Adds missing, removes extra. Endpoints: `POST /sync/:clinicId/insurance` (all doctors), `GET /sync/:clinicId/insurance/:doctoraliaDoctorId` (single doctor).
- **Sync status dashboard**: `GET /sync/:clinicId/status` returns health status (healthy/warning/error/never_synced), doctor counts (clinic-scoped), insurance breakdown (linked/pending/unlinked), and recent runs. Frontend `/sync` page shows status-based dashboard with auto-polling (3s when syncing, 15s idle).
- **Queue toggle**: `POST /sync/:clinicId/queue/toggle { enabled: bool }` pauses/resumes sync by setting `IntegrationConnection.status` to `paused`/`connected`. Only transitions paused↔connected (preserves other states). Validates boolean input. `triggerManualSync` and `triggerGlobalSync` check queue status and reject syncs when paused.
- **Frontend**: Mapping page shows turno badges (M/T/N with times), "Sync Slots" button per professional, calendar toggle.

## Multi-Tenant Security
- **User-clinic validation**: All `/sync/:clinicId/*` endpoints validate that the authenticated user has a role (`UserClinicRole`) for the specified `clinicId` before proceeding. Implemented via `validateUserClinicAccess()` in `SyncController`.
- **Doctor-clinic scoping**: `validateDoctorBelongsToClinic()` and `validateDoctoraliaDoctorBelongsToClinic()` ensure doctors belong to the clinic via `Mapping` table lookups.
- **Professional list scoping**: `getProfessionalMappings(clinicId)` only returns doctors that have a `Mapping` entry for the given clinic (filters by `vismedId in clinicVismedDoctorIds`).
- **Slot sync mapping scoping**: When `clinicId` is provided, `syncSlotsForDoctor` resolves the correct `ProfessionalUnifiedMapping` by filtering to vismed doctor IDs linked to the clinic.

## Bidirectional Booking Sync (VisMed ↔ Doctoralia)
- **BookingSyncService** (`apps/api/src/bookings/booking-sync.service.ts`): Core sync engine. Handles `slot-booked`, `booking-canceled`, `booking-moved` notifications from Doctoralia. Creates mirror appointments in VisMed. Uses atomic upsert for dedup to prevent race conditions on concurrent notifications.
- **Webhook endpoint**: `POST /webhooks/doctoralia` — public push endpoint for Doctoralia notifications. Resolves clinic by facilityId matching or falls back to first connected clinic.
- **Pull polling**: Staggered per-clinic polling via `startStaggeredPolling()`. Each clinic gets its own interval (base 3min, staggered by 6s per clinic). First poll delayed 15s after startup. Falls back to single-loop polling if no connections found.
- **BookingSyncController** (`/booking-sync/*`): Auth-protected endpoints — `GET /records` (with `start/end` date filters), `GET /stats`, `GET /health` (queue depth, rate limiter stats), `GET /metrics` (per-clinic throughput), `POST /retry-dead-letters`, `POST /book-from-vismed`, `DELETE /cancel/:id`, `POST /poll`.
- **BookingSync DB model**: Tracks all synced bookings with origin (VISMED/DOCTORALIA), status (BOOKED/CONFIRMED/CANCELLED/MOVED/FAILED/PROCESSING), patient data, timestamps, sync flags (`syncedToVismed`, `syncedToDoctoralia`). `doctoraliaBookingId` has unique index for dedup.
- **Frontend**: Weekly calendar view at `/appointments`. Doctor sidebar, unified V/D sync badges per appointment. Create/cancel booking modals with simultaneous VisMed+Doctoralia sync.
- **Dedup mechanism**: `booked_by === 'integration'` skips reverse sync (prevents loops). Atomic upsert with PROCESSING status prevents duplicate VisMed appointments from concurrent webhook/poll.

## Scalability Architecture (30 clinics × 400 bookings/day)
- **PostgreSQL-backed job queue** (`SyncJob` table + `QueueService`): Replaces Redis/BullMQ dependency. Claims jobs with `FOR UPDATE SKIP LOCKED` for safe concurrency. Aggressive worker loop fills up to 10 concurrent slots per tick (1s interval). Supports priorities, exponential backoff (2^attempt seconds, max 5min), and dead-letter after 5 failed attempts. Stale lock cleanup every 60s (properly tracked and cleared on shutdown).
- **Rate limiter** (`RateLimiterService`): Token bucket per provider. Doctoralia: 30 tokens, refill 10/s. VisMed: 20 tokens, refill 8/s. Auto-waits when bucket is empty.
- **Staggered polling**: Each clinic polls independently on its own interval, spread 6s apart. Dynamically refreshes every 5min to pick up new/removed clinic connections without restart.
- **Job deduplication**: Uses `dedupKey` (format: `clinicId:eventType:bookingId`) to prevent duplicate jobs from concurrent webhook + polling. Both `enqueue` and `enqueueBatch` check for existing PENDING/RUNNING jobs with same key.
- **Webhook security**: Clinic resolution requires exact facilityId match — no fallback to first connection. Prevents cross-tenant data corruption.
- **Monitoring**: `GET /booking-sync/health` (queue depth, active jobs, dead letters, rate limiter stats), `GET /booking-sync/metrics` (per-clinic throughput in last 24h), `POST /booking-sync/retry-dead-letters` (clinic-scoped only, requires clinicId).
- **Key files**: `apps/api/src/bookings/queue.service.ts`, `apps/api/src/bookings/rate-limiter.service.ts`.

## Key Files
- `apps/web/src/lib/api.ts` — HTTP client (fetches `/api/*` via Next.js proxy)
- `apps/web/src/lib/store.ts` — Zustand auth store with persist + hydration tracking (`_hasHydrated`)
- `apps/web/src/lib/clinic-store.ts` — Zustand clinic selection store with persist
- `apps/web/src/components/client-providers.tsx` — Client-side providers (Toaster) wrapper for RootLayout
- `apps/web/src/middleware.ts` — Auth middleware (cookie-based token check)
- `apps/web/next.config.js` — Next.js config with API proxy rewrites
- `apps/api/src/main.ts` — NestJS entry point
- `apps/api/src/app.module.ts` — NestJS root module
- `apps/api/prisma/schema.prisma` — Database schema
