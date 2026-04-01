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
2. **Doctoralia sync** (`full`): Pulls facilities, doctors, services from Docplanner API. Creates `DoctoraliaDoctor`, `DoctoraliaService`, `DoctoraliaAddressService` records and `Mapping` entries. Also fetches the global insurance providers dictionary (2717+ items) into `DoctoraliaInsuranceProvider`. Runs push sync back to Doctoralia.
3. **Global sync** (`/sync/:clinicId/global`): Triggers both pipelines in sequence.
4. **Matching Engine**: After sync, auto-matches VisMed specialties to Doctoralia services, VisMed doctors to Doctoralia doctors, and VisMed convênios (insurances) to Doctoralia insurance providers using exact/contains/fuzzy string similarity.

Both pipelines attempt BullMQ queue dispatch first, then fall back to direct inline execution if Redis is unavailable.

## Default Credentials
- Email: `admin@vismed.com`
- Password: `admin123`

## Mapping Module
- **Specialty deduplication**: `getProfessionalMappings` deduplicates specialties per doctor by `normalizedName` to avoid visual duplicates (e.g., "Clinico Geral" vs "Clínico Geral").
- **Insurance enrichment**: `findAll` for INSURANCE mappings now returns `doctoraliaCounterpart` with name/doctoraliaId from `DoctoraliaInsuranceProvider`.
- **Specialty stats**: `GET /mappings/specialties/stats` returns totalVismedSpecialties, totalDoctoraliaServices, totalMatched, totalUnmatched, coveragePercent.
- **Orphan cleanup safety**: `cleanupOrphans` in sync.processor.ts skips orphaning when activeIds is empty (for ALL entity types, not just DOCTOR).

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
