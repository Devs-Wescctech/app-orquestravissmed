# VisMed Workspace

## Overview
A monorepo for the VisMed platform — a medical scheduling and integration dashboard.

## Architecture
- **apps/web** — Next.js 14 frontend (main app, runs on port 5000)
- **apps/api** — NestJS backend with Prisma + BullMQ (legacy, not started by default)
- **supabase/** — Supabase Edge Functions that serve as the production API backend

## How It Runs
The web frontend communicates directly with Supabase Edge Functions (not the local NestJS API). All API calls from the frontend go to Supabase hosted infrastructure.

## Running the App
Workflow: `Start application` → `cd apps/web && npm run dev`
- Port: 5000 (required for Replit webview)
- Host: 0.0.0.0 (required for Replit proxy)

## Environment Variables
The app uses the following (currently hardcoded with defaults in `apps/web/src/lib/supabase.ts`):
- `NEXT_PUBLIC_SUPABASE_URL` — Supabase project URL
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Supabase anonymous key

## Package Manager
npm (workspace monorepo). Install web dependencies with: `cd apps/web && npm install`

## Key Files
- `apps/web/src/lib/supabase.ts` — Supabase client and Edge Function caller
- `apps/web/src/lib/api.ts` — Axios-compatible wrapper routing calls to Edge Functions
- `apps/web/src/middleware.ts` — Auth middleware (cookie-based token check)
- `apps/web/next.config.mjs` — Next.js configuration
