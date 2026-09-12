# Firstprint

Predict where newly listed crypto tokens trade 72 hours after they list.

In trading, the *first print* is a token's very first trade. Firstprint watches seven centralized exchanges for new listings, opens a prediction market for each one, and settles it on real exchange prices. Users sign in with a Solana wallet and stake points on one of five outcomes: Crash, Down, Flat, Up, or Moon.

**Launching the public website?** The static site is in `site/`. Follow [LAUNCH.md](LAUNCH.md) to put it online in minutes.

## What's in this repo

| Area | What it does |
|---|---|
| **Listing tracker** | Reads new-listing announcements (Binance, Bybit, OKX, Bitget, KuCoin) and detects new USDT trading pairs on all seven exchanges (adds MEXC and Gate). Detections appear on the public Listing radar page and wait for admin approval, or open markets automatically. |
| **Live data** | Pulls 1-minute candles for settlement and live tickers every few seconds, then streams prices to browsers over Server-Sent Events. |
| **Market engine** | Outcome buckets, 1-hour average prices at start and end, volume-weighted median across exchanges, pool caps, early-bird weights, payouts, and cancellation rules. |
| **Accounts** | Sign-In With Solana (Phantom, Solflare, Backpack, or any Wallet Standard wallet), with email and password as a fallback. Users, wallets, points, predictions, and settlements are stored in the database. |
| **Public website** | `site/`: landing page and app with a live exchange explorer. Predictions and listing radar are marked "Coming soon". Static, so it's free to host. |
| **Prediction app** | Markets, market page with live chart and outcome ladder, Listing radar, leaderboard, and portfolio with linked wallets. Works on desktop and mobile. |
| **Solana program** | `solana/`: an Anchor program for on-chain USDC prediction pools with oracle settlement, plus tests and an oracle script. Unaudited, devnet only. |

## Quick start

**New here? Follow [START-HERE.md](START-HERE.md)** to run the site with live tokens and real exchange prices before hosting.

Requires **Node.js 22.18 or newer**. The website and backend have no npm packages to install.

```bash
npm run setup       # creates .env and an admin key
npm run check       # tests every exchange connection
npm run dev         # http://localhost:8787 (admin at /#/admin)
npm run live        # creates 15-minute markets on live tokens
npm test            # 48 tests
```

Offline practice: set `SIM=1`, run `npm run seed`, then `npm run dev`. To preview the website with no server at all, open `dist/firstprint-preview.html`.

After changing `src/engine/engine.ts` or anything in `web/`, run `npm run build:web`.

### Live test markets

Live test markets use real exchange prices for tokens that already trade. Create them from the admin page or with `npm run live`. They run for 15 minutes, 1 hour, 24 hours, or 72 hours, and every exchange that has a live USDT price for the token is used. They're labeled "Live test" on the site, and admins can cancel any market with a full refund.

## Project structure

```
src/
  engine/engine.ts          Market math shared with the browser
  services/firstprint.ts    Accounts, wallets, points ledger, markets, detections, settlement
  api/server.ts             HTTP API, sessions, SSE stream, admin routes, static site
  exchanges/venues.ts       Binance, MEXC, Bybit, OKX, Gate, Bitget, KuCoin adapters
  exchanges/sim.ts          Simulated exchange for local development
  workers/listingTracker.ts Announcements and new-pair detection
  workers/liveFeed.ts       Live tickers to Server-Sent Events
  workers/scheduler.ts      Lifecycle, live, and tracker loops
  solana/siws.ts            Sign-In With Solana message and ed25519 verification
  solana/base58.ts
  auth/passwords.ts         scrypt hashing for email accounts
  db/schema.sql
web/
  app.js                    Website UI
  wallet.js                 Wallet Standard discovery, connect, sign message
  api.js / demo.js          Real backend client / in-browser demo backend
solana/                     Anchor program, tests, oracle (see solana/README.md)
test/                       engine, lifecycle, solana, exchanges
```

## Wallet sign-in

1. The browser requests `GET /api/auth/wallet/challenge?address=…`. The server stores a one-time nonce and the exact message.
2. The wallet signs the message with `solana:signMessage`. Signing is free and sends no transaction.
3. `POST /api/auth/wallet/verify` checks the ed25519 signature, the stored message, expiry (5 minutes), and single use. On first sign-in it creates the account with 1,000 points, then sets an HttpOnly session cookie.
4. New wallet accounts are asked to choose a username. Email accounts can link wallets from the portfolio page.

Messages follow the Sign-In With Solana layout and include the domain from `PUBLIC_URL`, so wallets can show where a request comes from.

## Exchange data

| Exchange | Announcements | New pairs | Trading start time | Candles | Live ticker |
|---|---|---|---|---|---|
| Binance | CMS feed (unofficial) | exchangeInfo | parsed from text | ✓ | ✓ |
| MEXC | none public | exchangeInfo | – | ✓ | ✓ |
| Bybit | v5 announcements | instruments-info | parsed from text | ✓ | ✓ |
| OKX | v5 announcements | instruments | `listTime` | ✓ | ✓ |
| Gate | – | currency_pairs | `buy_start` | ✓ | ✓ |
| Bitget | v2 announcements | symbols | parsed from text | ✓ | ✓ |
| KuCoin | v3 announcements | symbols | parsed from text | ✓ | ✓ |

⚠️ Fixture tests cover the adapters' parsing, but the adapters were written without live network access. Before launch, run the tracker against the real APIs on a staging server and fix any differences in response formats. Also check each exchange's terms for commercial use of its data. The Binance announcements feed is an unofficial website endpoint and may change without notice.

## API

Signed-in requests use the `fp_session` HttpOnly cookie (or `Authorization: Bearer <token>`). All POST bodies are JSON.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/auth/wallet/challenge?address=` | Sign-in message for a Solana address |
| POST | `/api/auth/wallet/verify` | `{ address, message, signature, walletName }`; signature in base58 or base64 |
| POST | `/api/auth/signup`, `/api/auth/login`, `/api/auth/logout` | Email fallback |
| GET | `/api/me` | Points, username, linked wallets |
| POST | `/api/me/profile` | `{ username }` |
| GET, POST | `/api/me/wallets` | List wallets, or link one (same signed-message body) |
| POST | `/api/me/claim-daily` | +100 points per UTC day |
| GET | `/api/me/predictions` | |
| GET | `/api/markets?filter=open\|live\|settled\|all` | |
| GET | `/api/markets/:id` | Includes live price and your predictions |
| GET | `/api/markets/:id/quote?bucket=&stake=` | Estimated payout |
| POST | `/api/markets/:id/predictions` | `{ bucket, stake }` |
| GET | `/api/markets/:id/chart`, `/activity`, `/settlement` | Settlement includes the data hash |
| GET | `/api/listings/detected` | Listing radar |
| GET | `/api/stream` | Server-Sent Events: `price`, `market`, `listing` |
| GET | `/api/leaderboard` | |

### Admin routes (header `x-admin-key`)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/admin/detected?status=pending` | Listings found by the tracker |
| POST | `/api/admin/detected/:id/approve` | `{ listingAt?, symbol?, name? }` opens a market |
| POST | `/api/admin/detected/:id/ignore` | |
| POST | `/api/admin/track` | Runs the tracker now |
| GET | `/api/admin/ping` | Checks the key; returns exchanges, lengths, suggested tokens |
| POST | `/api/admin/live-markets` | `{ symbol, exchanges?, startsInMinutes?, preset? }` (quick, hour, day, full) |
| GET | `/api/admin/markets` | All markets |
| POST | `/api/admin/markets/:id/cancel` | Cancel now and refund everyone |
| GET | `/api/admin/exchanges/check` | Calls every exchange and reports what works |
| POST | `/api/admin/markets` | Creates a market manually |
| POST | `/api/admin/markets/:id/listing-time`, `/retract`, `/halt` | Corrections |

Example approval:

```bash
curl -X POST http://localhost:8787/api/admin/detected/12/approve \
  -H 'content-type: application/json' -H "x-admin-key: $ADMIN_KEY" \
  -d '{ "listingAt": "2026-09-20T10:00:00Z", "name": "Kora Network" }'
```

## On Solana

The website runs on points by default. `solana/` contains an Anchor program for real on-chain pools that mirrors the engine. It covers:

- vaults owned by market PDAs, with early-bird weights;
- oracle settlement with a data hash you can verify against `/api/markets/:id/settlement`;
- automatic voids and claims.

See `solana/README.md` for build, test, deploy, and oracle instructions.

**Do not accept real money** until the program has been compiled, tested, professionally audited, and cleared by lawyers in every jurisdiction you serve. Many countries regulate prediction markets on price movements as gambling or derivatives.

## Before going live

- [ ] Test every exchange adapter against the live APIs on staging.
- [ ] Set `NODE_ENV=production`, `PUBLIC_URL`, and a long `ADMIN_KEY`, and serve over HTTPS.
- [ ] Move to PostgreSQL with backups once traffic grows (`schema.sql` maps directly).
- [ ] Add monitoring and alerts for failed tracking, ingestion, or settlement.
- [ ] Get legal advice before points gain any value or real-money pools launch.
- [ ] Check the name "Firstprint" for trademarks and domain availability.

---

Points have no cash value. Firstprint is independent and not affiliated with any exchange. This code is not legal or financial advice.
