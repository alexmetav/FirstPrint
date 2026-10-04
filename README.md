# Firstprint

Predict where newly listed crypto tokens trade 72 hours after they list.

In trading, the *first print* is a token's very first trade. Firstprint watches seven centralized exchanges for new listings, opens a prediction market for each one, and settles it on real exchange prices. Users sign in with a Solana wallet and stake points on one of five outcomes: Crash, Down, Flat, Up, or Moon.

**Launching the public demo?** The static source is in `site/`, the isolated read-only API starts with `npm run start:demo`, and [LAUNCH.md](LAUNCH.md) covers the Render and Vercel deployment.

## What's in this repo

| Area | What it does |
|---|---|
| **Listing tracker** | Reads new-listing announcements (Binance, Bybit, OKX, Bitget, KuCoin) and detects new USDT trading pairs on all seven exchanges (adds MEXC and Gate). Detections appear on the public Listing radar page and wait for admin approval, or open markets automatically. |
| **Live data** | Pulls 1-minute candles for settlement and live tickers every few seconds, then streams prices to browsers over Server-Sent Events. |
| **Market engine** | Outcome buckets, 1-hour average prices at start and end, volume-weighted median across exchanges, pool caps, early-bird weights, payouts, and cancellation rules. |
| **Accounts** | Continue with Google, a one-time email code, or Sign-In With Solana (Phantom, Solflare, Backpack, or any Wallet Standard wallet). Users, wallets, points, predictions, and settlements are stored in the database. |
| **Public website** | `site/`: the landing page (how it works, outcomes, rules, FAQ, a practice round) and the privacy policy. The app server serves it at `/` and the app at `/app/`. |
| **Prediction app** | Markets, market page with live chart and outcome ladder, Listing radar, leaderboard, a personal dashboard (win rate, points won, best win, history), and linked wallets. Works on desktop and mobile. |
| **Earn** | Tasks on X (honour-based, verified by linked username), invite links, and claiming points to your wallet as **TestFPT**, a Token-2022 token on Solana testnet that the server mints and the player pays the fee for. Admins set up the token and tasks in the admin panel. |
| **Solana program** | `solana/`: an Anchor program for on-chain USDC prediction pools with oracle settlement, plus tests and an oracle script. Unaudited, devnet only. |

## Signing in

One "Log in or sign up" popup, like Polymarket: **Continue with Google**, **Continue with email** (a 6-digit one-time code, no password), or a **Solana wallet**. All three lead to the same account when they share an email, and points stay on that account. Existing password accounts keep working: the same email signs in with a code or Google.

| Option | What you set up |
|---|---|
| Google | Create an OAuth "Web application" client ID in Google Cloud Console, add your site URL as an authorized JavaScript origin, and set `GOOGLE_CLIENT_ID`. Only the public client ID is needed; the server verifies Google's signed token itself. The button is hidden until it is set. |
| Email code | Set `RESEND_API_KEY` and `MAIL_FROM` (a sender on a domain verified at resend.com). Codes expire after 10 minutes, work once, lock after 5 wrong tries, and can be re-sent every 30 seconds. Outside production with no provider set, the code is printed in the server log and shown in the popup so you can try it locally. In production without a provider, the email option is hidden. |
| Wallet | Already works (Sign-In With Solana). Set `SOLANA_CHAIN=devnet` or `testnet` for test networks. |

## Running markets from the admin panel

By default (`MANUAL_ONLY=1`) admins run markets at `/#/admin`, and the only thing fetched from exchanges by itself is MEXC's list of new pairs (see *New listings* below):

1. **Exchanges:** switch exchanges on or off. Only enabled exchanges can be used in new markets.
2. **Create a market:** token, start price, which exchanges, when predictions close, when the result is expected, a description, and optional outcome ranges, fee and pool limit. Save as a draft (users can't see it) or publish.
3. **Edit:** drafts are fully editable. After users have predicted, the token, start price, ranges and pool rules lock; the description, exchanges and a *later* close time can still change. You can unpublish only while nobody has predicted, and cancel with a full refund at any time before the result.
4. **Timer ends:** the market closes automatically and waits under "Waiting for your result". Nothing settles by itself.
5. **Post the result:** enter the final price. The panel previews the winning outcome, the winners and each payout; confirm to pay. The result, final price, your note and the winners then appear on the market page. You can override the outcome if the price source was disputed. If nobody picked the winning outcome, or everyone picked the same one, the market is cancelled and refunded.

### New listings and Telegram alerts

Every 2 minutes the server checks MEXC's public pair list (`/api/v3/exchangeInfo`, no API key) for new USDT pairs. Each new one appears under **New listings** in Admin (Overview and Markets) and, if connected, as a Telegram message. **Review** opens the market form already filled in: symbol, name, MEXC, close time (when trading starts for an upcoming token, otherwise an hour from now), a result 72 hours after listing, a description, and the live MEXC price with a one-click "Use as start price". Add the logo link (a copy is saved), check everything, and publish. **Skip** removes it. Tokens that already have a market, pairs that opened more than a day ago, and listings left for 3 days are dropped. Admins can pause the check in Settings; `AUTO_LISTINGS=0` turns it off, and `AUTO_LISTINGS=publish` instead opens self-settling markets straight away (at most `AUTO_MARKETS_PER_DAY`, default 5, a day, with results after `AUTO_MARKET_HOURS`, default 72). Results for admin-run markets have a "Use live price" button too.

Telegram alerts: create a bot with @BotFather, set `TELEGRAM_BOT_TOKEN` on the server, then in Admin → Settings send the shown code to the bot and click Connect. Alerts go out for new listings and for markets that close and need a result. For players, add the same bot as an admin (with Post Messages) of a public channel and enter its name under **Player channel** in Settings: every published market is posted there with a *Predict now* button, and every result when it's in. Players then see a Telegram button on market pages, on their dashboard and profile, and in the menu. The server must stay awake for any of this (Render's free plan sleeps, so ping `/api/health` every few minutes).

Set `MANUAL_ONLY=0` to bring back the exchange scanner, live prices and live test markets.

## Quick start

**New here? Follow [START-HERE.md](START-HERE.md)** to run the site with live tokens and real exchange prices before hosting.

Requires **Node.js 22.18 or newer**. The website and backend have no npm packages to install.

```bash
npm run setup       # creates .env and an admin key
npm run check       # tests every exchange connection
npm run dev         # http://localhost:8787 (admin at /#/admin)
npm run live        # creates 15-minute markets on live tokens
npm test            # unit and HTTP tests
```

Offline practice: set `SIM=1`, run `npm run seed`, then `npm run dev`. To preview the prediction app with no server at all, open `dist/firstprint-preview.html`; `dist/firstprint-site-preview.html` previews the landing page.

After changing `src/engine/engine.ts` or anything in `web/`, run `npm run build:web`.

### Live test markets

Live test markets use real exchange prices for tokens that already trade. Create them from the admin page or with `npm run live`. They run for 15 minutes, 1 hour, 24 hours, or 72 hours, and every exchange that has a live USDT price for the token is used. They're labeled "Live test" on the site, and admins can cancel any market with a full refund.

## Project structure

```
src/
  engine/engine.ts          Market math shared with the browser
  services/firstprint.ts    Accounts, wallets, points ledger, markets, detections, settlement
  api/server.ts             HTTP API, sessions, SSE stream, admin routes, static site
  demo.ts / demoServer.ts   Isolated read-only public demo service
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
