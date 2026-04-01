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
- **Doctoralia/Docplanner**: OAuth2 client credentials flow. Credentials stored in `IntegrationConnection` with provider `doctoralia` (fields: `clientId`, `clientSecret`, `domain`). Domain must include `www` prefix (e.g., `www.doctoralia.com.br`).
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
- **Manual approval threshold**: Matches (specialties and insurance/convênios) with score < 70% require manual approval. Specialties get `requiresReview=true`, insurance gets `PENDING_REVIEW` status. Approve/reject via `POST /mappings/insurance/approve` and `/reject` (clinic-scoped).
- **Orphan cleanup safety**: `cleanupOrphans` in sync.processor.ts skips orphaning when activeIds is empty (for ALL entity types, not just DOCTOR).

## Turnos (Work Shifts) Module
- **turnoM/T/N fields** on `VismedDoctor`: Stores morning/afternoon/night shift times (e.g. `"08:00 - 12:00"`).
- **Sync paths**: Both `sync.service.ts` (global sync) and `vismed-sync.processor.ts` (queue-based) persist turno data from VisMed API field `turno_m/t/n`.
- **SlotSyncService** (`slot-sync.service.ts`): Converts turnoM/T/N into Doctoralia calendar slots via `replaceSlots` API. Generates slots for next 30 days per address with services. Unified mapping selection is clinic-scoped when clinicId is provided. Auto-provisions address services from specialty mappings when no services exist on an address. Uses a candidate fallback mechanism: tries mapped `doctoraliaServiceId` first, then alternatives with same normalizedName sorted by numeric ID (lowest first = dictionary IDs), stopping on success or non-retryable errors (401/403/429/5xx).
- **Calendar Breaks API**: `DocplannerClient` supports `getCalendarBreaks`, `addCalendarBreak`, `moveCalendarBreak`, `deleteCalendarBreak`.
- **Endpoints**: `POST /sync/:clinicId/slots/:vismedDoctorId` (single), `POST /sync/:clinicId/slots` (all), `GET /sync/shifts/:vismedDoctorId`, `POST /sync/:clinicId/calendar/:doctorId/enable|disable`.
- **Push-sync integration**: After services delta sync, automatically calls `slotSync.syncSlotsForDoctor` for doctors with turnos.
- **Frontend**: Mapping page shows turno badges (M/T/N with times), "Sync Slots" button per professional, calendar toggle.

## Multi-Tenant Security
- **User-clinic validation**: All `/sync/:clinicId/*` endpoints validate that the authenticated user has a role (`UserClinicRole`) for the specified `clinicId` before proceeding. Implemented via `validateUserClinicAccess()` in `SyncController`.
- **Doctor-clinic scoping**: `validateDoctorBelongsToClinic()` and `validateDoctoraliaDoctorBelongsToClinic()` ensure doctors belong to the clinic via `Mapping` table lookups.
- **Professional list scoping**: `getProfessionalMappings(clinicId)` only returns doctors that have a `Mapping` entry for the given clinic (filters by `vismedId in clinicVismedDoctorIds`).
- **Slot sync mapping scoping**: When `clinicId` is provided, `syncSlotsForDoctor` resolves the correct `ProfessionalUnifiedMapping` by filtering to vismed doctor IDs linked to the clinic.

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
