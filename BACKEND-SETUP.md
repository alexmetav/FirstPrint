# FirstPrint backend setup

**You don't need this file to run Firstprint.** The live setup is the single-instance `firstprint-app` Render service described in [LAUNCH.md](LAUNCH.md): it runs on Render's free plan, keeps its SQLite database in a private Supabase Storage bucket (restored at start-up, copied every minute), and needs no payment.

Sign-in is by Google, a one-time email code (Resend) or a Solana wallet. Accounts, the points ledger, daily streaks, predictions, admin-run markets, the MEXC new-listings queue, Telegram alerts, TestFPT claims and analytics all run in that one service.

## Only needed to run more than one instance

SQLite lives in one process, so the app must stay a **single instance**. To scale out later:

- Move persistence from synchronous SQLite to PostgreSQL transactions (`src/db/schema.sql` maps directly) and re-check concurrent predictions, daily claims and exactly-once settlement against the real database.
- Run the background jobs (market lifecycle, MEXC check, Telegram reminders) in one worker, not in every web instance.
- Keep `PUBLIC_URL` equal to the address people use, so wallet sign-in and cookies keep working.

## Local developer check

Requires Node 22.18+.

```
npm install
npm test
npm run typecheck
npm run setup
npm run dev
```

Visit http://localhost:8787 for the app. The public site build is `npm run build:deploy`.

## Read-only demo deployment

`render.yaml` also defines `firstprint-demo-api`, an isolated service whose `npm run start:demo` command exposes only `GET /api/health` for the Vercel copy of the website. It has no database, accounts or admin routes.
