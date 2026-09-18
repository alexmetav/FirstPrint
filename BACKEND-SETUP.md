# FirstPrint backend setup

## Current status

The existing Node/TypeScript backend runs locally and provides email/password and wallet accounts, a points ledger, predictions, listing detection, live events, and settlement. It uses **SQLite**, not Supabase/PostgreSQL, and its own authentication, not Supabase Auth. This preparation does not complete that migration or launch a cloud backend.

The public website is built from `site/`. A separate prediction interface is copied to `/play/`; without an API it reports an error instead of silently showing fake balances. Explicit practice remains available with `/play/?demo=1`.

## Your tasks (no coding)

1. Sign up at https://supabase.com/dashboard and https://dashboard.render.com. GitHub sign-in is convenient.
2. In Supabase create a project named `firstprint-staging`. Keep the database password in your password manager. Use the free plan for initial setup; do not buy anything yet.
3. In Render connect GitHub and allow access to `alexmetav/FirstPrint`. Do not create a paid service yet.
4. Tell Codex the Supabase project URL and chosen region, and that Render can see the repository. The project URL is not a password. Do not paste the database password, connection string, secret key, or service-role key into chat.

## Remaining implementation before hosted launch

- Migrate synchronous SQLite persistence to asynchronous PostgreSQL transactions; verify concurrent predictions, daily claims, and exactly-once settlement with the real database.
- Integrate Supabase authentication and map verified users to the points ledger.
- Configure Render API and worker services, their private environment variables, and a shared database. Review hosting cost before creating paid services.
- Connect the Vercel frontend using a same-origin API proxy so HttpOnly sessions work without third-party cookies. PUBLIC_URL must match the browser-facing origin.
- Test live exchange APIs from the selected hosting region, then test signup, prediction, settlement, and restart recovery end to end.

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

`GET /api/market-data?path=<URL-encoded provider path>` accepts only the existing exchange explorer's fixed CoinGecko endpoints. It returns `{ data, updatedAt, stale }`. Concurrent requests share a fetch; successful data is cached for a minute. Provider outages return explicitly stale data for at most an hour, with a one-minute retry cooldown. Optional `COINGECKO_API_KEY` stays on the server. The public site has not yet been connected to this endpoint.

## Deployment limitations

Do not deploy the current SQLite database onto an ephemeral filesystem or run several backend instances against independent copies. The existing local backend is a staging foundation; use the planned PostgreSQL migration before launching the recommended Render API/worker architecture. Exchange fixture tests do not prove live provider availability.
