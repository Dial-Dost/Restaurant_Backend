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
| `SUPABASE_DIRECT_URL` | Yes | Direct Postgres URL from Supabase project settings. |
| `DATABASE_URL` | No | Optional alias; defaults to `SUPABASE_DIRECT_URL` when unset. |
| `DIRECT_URL` | No | Optional alias; defaults to `SUPABASE_DIRECT_URL` when unset. |
| `ALLOWED_ORIGINS` | No | Comma separated list used by the simple CORS guard. |
| `OPENAI_API_KEY` | No | Enables `/realtime/session` for Realtime API key vending. |

Place secrets in `.env` locally and in repository/environment secrets for CI/CD. Never commit the filled `.env`.

## NPM Scripts

| Command | Purpose |
| ------- | ------- |
| `npm run dev` | Watches `index.ts` with TSX; auto-restarts on change. |
| `npm run build` | Emits JS to `build/` using `tsconfig.build.json`. |
| `npm run start` | Runs the compiled server (`node ./build/index.js`). |
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

This repository ships with `.github/workflows/backend-ci.yml` which runs on pushes and pull requests to `main`:

1. Checkout + install dependencies with `npm ci`.
2. Build the TypeScript project.
3. Start the compiled server in the background.
4. Poll `/health` to confirm Postgres connectivity (uses `SUPABASE_DIRECT_URL` secret).
5. Run the allocation, overlap, threshold, and Jest suites.

### Required Secrets for CI

| Secret | Use |
| ------ | --- |
| `SUPABASE_DIRECT_URL` | Direct Postgres connection string for CI. |
| `DATABASE_URL` | Optional alias for tools expecting this key. |

The workflow automatically waits for `/health`; ensure the Postgres user has permissions to read/write required tables.

## Repository Hygiene

- Run `npm run lint` (if you add ESLint) before opening PRs.
- Keep `schema.ts` in sync with any Postgres schema changes.
- When altering restaurant seed data, update `EnsureRestaurantSeed` plus downstream fixtures.
- Always add/refresh unit or integration scripts for new booking edge cases to keep regression coverage high.
