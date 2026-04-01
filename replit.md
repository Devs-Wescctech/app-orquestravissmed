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
Workflow: `Start application` → `cd apps/api && node dist/src/main.js & cd apps/web && npm run dev`

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
- API build: `cd apps/api && npx nest build`
- Web dev: `cd apps/web && npm run dev`

## Default Credentials
- Email: `admin@vismed.com`
- Password: `admin123`

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
