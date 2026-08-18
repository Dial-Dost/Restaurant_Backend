# Restaurant Backend

Node/Express API that stores restaurant bookings, customer profiles, and table assignments for the ReceptionAI voice assistant and the new dashboard UI.

## Tech Stack

- Node 20 + Express 5 (ESM)
- Supabase Postgres (direct connection)
- Zod for payload validation and csv-parse for the knowledge snapshot
- Jest + TSX-powered integration scripts for allocation regressions

## Prerequisites

- Node 20 (use `nvm use 20` or Volta)
- npm 10+
- Supabase project with direct Postgres URL
- Optional: OpenAI key if you call the realtime session endpoint

## Quick Start

```bash
git clone https://github.com/Dial-Dost/Restaurant_Backend.git
cd Restaurant_Backend
cp .env.example .env
npm install
npm run dev
```

### Environment Variables

| Name | Required | Description |
| ---- | -------- | ----------- |
| `SUPABASE_DIRECT_URL` | Yes | Direct Postgres URL from Supabase project settings (also used by optional Python legacy service in `npm run dev:full` / `npm run start:full`). |
| `DATABASE_URL` | No | Optional alias; defaults to `SUPABASE_DIRECT_URL` when unset. |
| `DIRECT_URL` | No | Optional alias; defaults to `SUPABASE_DIRECT_URL` when unset. |
| `ALLOWED_ORIGINS` | No | Comma separated list used by the simple CORS guard. |
| `OPENAI_API_KEY` | No | Enables `/realtime/session` for Realtime API key vending. |

Place secrets in `.env` locally and in repository/environment secrets for CI/CD. Never commit the filled `.env`.

## NPM Scripts

| Command | Purpose |
| ------- | ------- |
| `npm run dev` | Default local development (Node + Supabase only). Watches `index.ts` with TSX and auto-restarts on change. |
| `npm run dev:full` | Runs Node + the optional Python legacy service together. |
| `npm run build` | Emits JS to `build/` using `tsconfig.build.json`. |
| `npm run start` | Runs the compiled Node server only (`node ./build/index.js`). |
| `npm run start:full` | Runs compiled Node server + optional Python legacy service. |
| `npm run test:allocation` | Deterministic table-allocation regression test. |
| `npm run test:overlap` | Verifies overlapping bookings are rejected. |
| `npm run test:threshold` | Exercises configurable capacity limits. |
| `npm run test:integration` | Happy-path booking round trip simulation. |
| `npm run jest` | Any additional Jest unit tests (`--passWithNoTests`). |
| `npm run test:ci` | Build + Jest serial run for GitHub Actions. |

## API Surface

- `GET /health` – Readiness probe that also pings Supabase Postgres.
- `GET /reception/info` – Returns the static restaurant knowledge snapshot.
- `POST /reception/check-availability` – Pure availability calculation.
- `POST /reception/create-reservation` – Allocates tables and persists bookings.
- `POST /add-customer` – Idempotent customer creation.
- `POST /add-booking` / `DELETE /table/:name` / `PATCH` helpers defined in `index.ts` for the dashboard and voice assistant.
- `POST /realtime/session` – Thin wrapper around OpenAI’s Realtime Session API when configured.

Every mutating route expects a `restaurantId` via header `x-restaurant-id`, query `restaurantId`, or JSON body.

## Running Tests Locally

1. Ensure Supabase Postgres is reachable at `SUPABASE_DIRECT_URL` and the seed restaurant can be written.
2. Run `npm test` style commands above. For the full integration parity run: `npm run test:ci`.
3. Use `npm run build && node ./build/index.js` to mimic production start-up before cutting a release.

## Deployment Notes

- Build artifacts live in `build/` and can be packaged into a Docker image or Azure Web App.
- The server listens on port `3000`; set `PORT` in your host environment if you need to override (process managers can wrap `npm run start`).
- Provision the following secrets for your deployment target:
  - `SUPABASE_DIRECT_URL`
  - `DATABASE_URL` (optional alias)
  - `DIRECT_URL` (optional alias)
  - `OPENAI_API_KEY` (optional)
  - `ALLOWED_ORIGINS` (set to your dashboard + receptionist hostnames)

## Continuous Integration

All CI lives in a single workflow, `.github/workflows/ci.yml`, which runs on pushes to
`main`/`master` and on pull requests. It has two jobs:

**`backend`** — runs on the runner against ephemeral `postgres:16` / `redis:7` service containers:

1. `npm ci`.
2. `npm run test:money` — money invariants (no database, no Docker; fails in seconds).
3. `npm run build` — TypeScript typecheck.
4. `npx jest --runInBand` — unit tests.
5. `npm run migrate && npm run test:isolation` — the migration chain plus the tenant-isolation regression.
6. `npm run test:integration` — end-to-end money/flow tests against the throwaway Postgres.

**`docker`** — container packaging smoke test: builds `Dockerfile.node` and `Dockerfile.python`,
applies migrations to a throwaway Postgres, brings the compose stack up, and polls `/health`
(which returns 503 when the database is unreachable, so a 200 proves the built image boots on
pruned production `node_modules` *and* reached its database). The throwaway datastores come from
the CI-only override `.github/docker-compose.ci.yml`.

### Required Secrets for CI: none

**CI must never be given a production credential, and today references no repository secret at
all.** Every database URL in the workflow is a literal pointing at a service container that is
destroyed when the job ends.

This is deliberate and load-bearing. A previous workflow (`backend-ci.yml`, deleted 2026-08-18)
set `RESTAURANT_ID: csrorganics` — a live tenant — and pointed `SUPABASE_DIRECT_URL`,
`DATABASE_URL` and `DIRECT_URL` at the production Supabase secret, then ran write-capable API
tests against it on every push and every pull request. Do not reintroduce a production
connection string, a real tenant slug, or `NODE_ENV=test`/`development` for the compose stack —
see the header comment in `ci.yml` for why each of those is dangerous.

### Known coverage gap

`test/valet_api_test.ts` and `test/feedback_api_test.ts` do not run automatically. They
authenticate with `X-Restaurant-Id` / `X-Action-List` headers, but the backend moved to
session-only bearer-token auth, so every authenticated call in them now returns 401 — they have
been contributing no verification since that refactor. They are gated behind a
`workflow_dispatch` input (`run_api_tests`) until they are rewritten onto the existing
`test/_auth.ts` login helper; the `ci.yml` step comment spells out exactly what that rewrite
involves.

## Repository Hygiene

- Run `npm run lint` (if you add ESLint) before opening PRs.
- When altering restaurant seed data, update `EnsureRestaurantSeed` plus downstream fixtures.
- Always add/refresh unit or integration scripts for new booking edge cases to keep regression coverage high.
