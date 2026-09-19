# FirstPrint backend setup

## Current status

The existing Node/TypeScript backend runs locally and provides email/password and wallet accounts, a points ledger, predictions, listing detection, live events, and settlement. It uses **SQLite**, not Supabase/PostgreSQL, and its own authentication, not Supabase Auth. This preparation does not complete that migration or launch a cloud backend.

The public website is built from `site/`. A separate prediction interface is copied to `/play/` and forced into browser-only practice mode during the deployment build. It never calls prediction, authentication, database, worker, or admin routes.

## Your tasks (no coding)

1. Sign up at https://supabase.com/dashboard and https://dashboard.render.com. GitHub sign-in is convenient.
2. In Supabase create a project named `firstprint-staging`. Keep the database password in your password manager. Use the free plan for initial setup; do not buy anything yet.
3. In Render connect GitHub and allow access to `alexmetav/FirstPrint`. Do not create a paid service yet.
4. Tell Codex the Supabase project URL and chosen region, and that Render can see the repository. The project URL is not a password. Do not paste the database password, connection string, secret key, or service-role key into chat.

## Remaining implementation before hosted launch

- Migrate synchronous SQLite persistence to asynchronous PostgreSQL transactions; verify concurrent predictions, daily claims, and exactly-once settlement with the real database.
- Integrate Supabase authentication and map verified users to the points ledger.
- Configure the full Render API and worker services, their private environment variables, and a shared database. Review hosting cost before creating paid services.
- Connect the Vercel frontend using a same-origin API proxy so HttpOnly sessions work without third-party cookies. PUBLIC_URL must match the browser-facing origin.
- Test live exchange APIs from the selected hosting region, then test signup, prediction, settlement, and restart recovery end to end.

## Supabase wallet-points beta

The first PostgreSQL migration is `supabase/migrations/202609190001_points_beta.sql`. Run it once in the Supabase SQL editor for the staging project. It creates RLS-protected profiles, an append-only points ledger, rotating practice markets, idempotent predictions, atomic daily claims, deterministic practice settlement, and a limited leaderboard.

In Supabase Auth, enable the Solana Web3 provider and register `https://first-print.vercel.app/**` as a redirect URL. In Vercel, set the public `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` build variables. Never use a secret or service-role key in these browser variables. The beta will then be available at `/beta/`.

## Local developer check

Requires Node 22.18+.

```
npm install
npm test
npm run typecheck
npm run setup
npm run dev
```

Visit http://localhost:8787 for the actual backend-connected prediction app. The public site build is `npm run build:deploy`.

## New market-data endpoint

`GET /api/market-data?path=<URL-encoded provider path>` accepts only the exchange explorer's fixed CoinGecko endpoints. It returns `{ data, updatedAt, stale }`. Concurrent requests share a fetch; successful data is cached for a minute. Provider outages return explicitly stale data for at most an hour, with a one-minute retry cooldown. Optional `COINGECKO_API_KEY` stays on the server. The public site uses this endpoint through a same-origin Vercel rewrite.

## Read-only demo deployment

`render.yaml` defines `firstprint-demo-api`, a deliberately isolated Render service. Its `npm run start:demo` command starts `src/demo.ts`, which exposes only:

- `GET /api/health`
- `GET /api/market-data`

It does not open SQLite or expose authentication, predictions, points, admin routes, settlement, listing tracking, or workers. In Render, create the Blueprint from this repository and add `COINGECKO_API_KEY` as a private environment variable if required. The Vercel rewrites assume the service URL is `https://firstprint-demo-api.onrender.com`; update `vercel.json` if Render assigns another URL.

Before sharing the demo, verify from the deployed Vercel site that `/api/health` returns `mode: "read-only-demo"`, every exchange page loads, stale data is labelled, and `/play/` shows the practice-only banner.

## Deployment limitations

Do not deploy the current SQLite database onto an ephemeral filesystem or run several backend instances against independent copies. The existing local backend is a staging foundation; use the planned PostgreSQL migration before launching the recommended Render API/worker architecture. Exchange fixture tests do not prove live provider availability.
