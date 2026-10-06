# Firstprint

Predict where newly listed crypto tokens trade after they list.

In trading, the *first print* is a token's very first trade. Firstprint runs prediction markets on newly listed tokens. Admins open the markets (new listings on MEXC, OKX, Gate, Bitget and KuCoin are detected automatically and queued for review) and post the result. Players sign in with Google, an email code or a Solana wallet and stake free points on a five-outcome ladder (Crash, Down, Flat, Up, Moon) or a Yes/No question. Points have no cash value; the 1,000 starting points and Earn rewards can be claimed as TestFPT on Solana's test network.

The full seven-exchange scanner with self-settling markets also exists (`MANUAL_ONLY=0`), but production runs admin-run markets (`MANUAL_ONLY=1`).

**Launching the public demo?** The static source is in `site/`, the isolated read-only API starts with `npm run start:demo`, and [LAUNCH.md](LAUNCH.md) covers the Render and Vercel deployment.

## What's in this repo

| Area | What it does |
|---|---|
| **Listing tracker** | Reads new-listing announcements (Binance, Bybit, OKX, Bitget, KuCoin) and detects new USDT trading pairs on all seven exchanges (adds MEXC and Gate). With `MANUAL_ONLY=0`, detections appear on the public Listing radar page and wait for admin approval, or open markets automatically. With `MANUAL_ONLY=1` (production) only MEXC, OKX, Gate, Bitget and KuCoin are checked (`LISTING_VENUES`), and new listings wait in Admin → New listings. |
| **Live data** | Pulls 1-minute candles for settlement and live tickers every few seconds, then streams prices to browsers over Server-Sent Events. |
| **Market engine** | Outcome buckets, 1-hour average prices at start and end, volume-weighted median across exchanges, pool caps, early-bird weights, payouts, and cancellation rules. |
| **Accounts** | Continue with Google, a one-time email code, or Sign-In With Solana (Phantom, Solflare, Backpack, or any Wallet Standard wallet). Users, wallets, points, predictions, and settlements are stored in the database. |
| **Public website** | `site/`: the landing page (how it works, outcomes, rules, FAQ, a practice round) and the privacy policy. The app server serves it at `/` and the app at `/app/`. |
| **Prediction app** | Markets, market page with chart and outcome ladder, leaderboard, a personal dashboard (win rate, points won, best win, history), shareable PnL cards for every settled prediction (an image drawn on the server at `/share/pnl/<market>/<username>.png`, and a link page whose preview on X is that card; Post on X, Save image, Share and Copy link from the market page, dashboard, results inbox and win popup), daily streak (50 points on day 1, +25 a day, 200 a day from day 7; a missed UTC day starts again), linked wallets, and a Telegram button for the player channel. Works on desktop and mobile. |
| **Admin** | Create and settle markets, New listings review queue, live price checks, an Exchange check in Settings (which exchanges this server can reach, and which refuse its location), Telegram alerts and the player channel, TestFPT and tasks, and **Analytics** with a read-only share link for partners (`#/stats/<key>`, totals only, can be rotated or turned off). |
| **Earn** | Tasks on X (honour-based, verified by linked username), invite links, and claiming points to your wallet as **TestFPT**, a Token-2022 token on Solana testnet that the server mints and pays the fee for (players with their own wallet claim with one click and sign nothing; only if the mint authority runs out of test SOL does a claim fall back to the wallet signing and paying). Admins set up the token and tasks in the admin panel. |
| **On-chain (Phase 1)** | With `WALLET_ENCRYPTION_KEY` set, every player without a wallet (email and Google sign-ups, and older accounts on their next visit) gets a **Firstprint wallet**: a Solana keypair made by the server, its key sealed with AES-256-GCM under that secret (never in the database in plain text). Every daily streak claim is minted to the player's wallet (the Firstprint wallet, or else their first linked one) as TestFPT, and Firstprint-wallet players' rewards (welcome bonus, tasks, referrals) are claimed for them; the server signs and pays every fee, so players never need test SOL. Each mint is recorded before it is sent and retried only once its blockhash has expired, so nothing is minted twice. The dashboard lists the wallet and every transaction with its Solana Explorer link; the admin TestFPT panel shows the counts and warns when the mint authority runs low on test SOL (mints pause below 0.01 SOL). **Phase 2:** for Firstprint-wallet players every prediction is also a TestFPT transfer from their wallet to the escrow (the mint authority's token account), and every payout or refund a transfer back, each with a memo such as `firstprint:stake:<market>:<outcome>`; the server signs for the wallet with its unsealed key and pays the fee. Points earned before TestFPT was on chain are topped up by minting, so a wallet always matches its points. Each waits for confirmation before the next. Players with their own wallet would have to sign every prediction, so theirs stay as points. |
| **Solana program** | `solana/`: an Anchor program for on-chain USDC prediction pools with oracle settlement, plus tests and an oracle script. Unaudited, devnet only. |

## Signing in

One "Log in or sign up" popup, like Polymarket: **Continue with Google**, **Continue with email** (a 6-digit one-time code, no password), or a **Solana wallet**. All three lead to the same account when they share an email, and points stay on that account. Existing password accounts keep working: the same email signs in with a code or Google.

| Option | What you set up |
|---|---|
| Google | Create an OAuth "Web application" client ID in Google Cloud Console, add your site URL as an authorized JavaScript origin, and set `GOOGLE_CLIENT_ID`. Only the public client ID is needed; the server verifies Google's signed token itself. The button is hidden until it is set. |
| Email code | Set `RESEND_API_KEY` and `MAIL_FROM` (a sender on a domain verified at resend.com). Codes expire after 10 minutes, work once, lock after 5 wrong tries, and can be re-sent every 30 seconds. Outside production with no provider set, the code is printed in the server log and shown in the popup so you can try it locally. In production without a provider, the email option is hidden. |
| Wallet | Already works (Sign-In With Solana). Set `SOLANA_CHAIN=devnet` or `testnet` for test networks. |

## Running markets from the admin panel

**Opening the admin console.** Set `ADMIN_EMAILS` (comma-separated) and/or `ADMIN_WALLETS` (Solana addresses) on the server, then simply log in on the site: an email in the list opens `#/admin` when signed in with Google or an email code (a password sign-in never counts, since it didn't prove the address), and a wallet in the list when it is linked to the signed-in account. Admin accounts see **Admin console** in the menu. Those are the **owner**. Under **Settings → Team** the owner gives other people access by email or Solana wallet, as **Admin** (everything except the team list), **Listings + tasks** (review new listings; create, edit, schedule, publish, unpublish and delete markets; post them to Telegram; manage tasks; but not results, refunds, analytics, the token or settings) or **Tasks only** (a console with just the Tasks page); the same sign-in rules apply, and removing someone takes effect on their next request. The `ADMIN_KEY` still works (as owner) for anyone without such an account; **Lock admin** closes the console for the rest of the page visit.

By default (`MANUAL_ONLY=1`) admins run markets at `/#/admin`, and the only things fetched from exchanges by themselves are new pairs and listing announcements (see *New listings* below):

1. **Exchanges:** switch exchanges on or off. Only enabled exchanges can be used in new markets.
2. **Create a market:** token, start price, which exchanges, when predictions close (presets: open 24 or 48 hours), when the result is expected (presets: 15 or 30 days after the close), a description, and optional outcome ranges, fee and pool limit. By default **Start price is the price when predictions close** is ticked: no price is typed, and once predictions close the server reads the price from the market's sources (the median of the last three one-minute closes before the close on each exchange, or the last three CoinGecko points) and locks it as the start price, so a token that climbs while predictions are open gives nobody an edge; if no source answers within two hours the admin is asked for it on Telegram. Untick it for a fixed start or target price. Closed markets then show in the app's **Countdown** tab with the time left to their result, and the admin is asked for the result only when it is due. Save as a draft (users can't see it) or publish. For a token that isn't trading yet, tick **Upcoming token** (predictions close when trading starts; once it trades, the server reads the opening price from the middle of its 2nd–4th minutes of trading on the chosen exchanges and sets it as the start price by itself, and the admin is asked for the result only when the result time comes, or for the opening price if no trades appear within a day), and optionally **Open by itself when trading starts** with the trading start time: the market then waits as a draft with a countdown in Markets. Every 30 seconds after that time the server checks the chosen exchanges; once the token has traded for 3 full minutes and the live price agrees with those minutes (within 10%, so an opening spike is skipped), predictions open and the channel post goes out (the start price is then the price when predictions close), and the admin gets a Telegram message. It needs a logo and predictions open at least 30 minutes after trading starts; if trading hasn't started 3 hours after the set time, or the market is no longer ready, it stays a draft and the admin is told why.
3. **Edit:** drafts are fully editable. After users have predicted, the token, start price, ranges and pool rules lock; the description, exchanges and a *later* close time can still change. You can unpublish only while nobody has predicted, and cancel with a full refund at any time before the result.
4. **Timer ends:** the market closes automatically and waits under "Waiting for your result". Nothing settles by itself.
5. **Post the result:** enter the final price. The panel previews the winning outcome, the winners and each payout; confirm to pay. The result, final price, your note and the winners then appear on the market page. You can override the outcome if the price source was disputed. If nobody picked the winning outcome, or everyone picked the same one, the market is cancelled and refunded.

### New listings and Telegram alerts

Every 2 minutes the server checks the public pair lists of MEXC, OKX, Gate, Bitget and KuCoin (no API keys) for new USDT pairs, plus the listing announcements of OKX, Bitget and KuCoin. `LISTING_VENUES` (comma-separated ids) changes the list; Binance and Bybit refuse servers in the US, so add them only on a server in another region (Admin → Settings → **Exchange check** shows which exchanges answer). Switching an exchange off under Reference exchanges stops checking it too. Each new listing appears under **New listings** in Admin (Overview and Markets) and, if connected, as a Telegram message. A token that already has a market or is already waiting (found on another exchange, or announced first) is not repeated, and announcements more than 2 days old are skipped. **Review** opens the market form already filled in: symbol, name, the exchange it listed on, close time (when trading starts for an upcoming token, otherwise 48 hours from now, with the start price taken at the close), a result 15 days after the close, a description, and the live price for reference. Add the logo link (a copy is saved), check everything, and publish. **Skip** removes it. Tokens that already have a market, pairs that opened more than a day ago, and listings left for 3 days are dropped. Admins can pause the check in Settings; `AUTO_LISTINGS=0` turns it off, and `AUTO_LISTINGS=publish` instead opens self-settling markets straight away (at most `AUTO_MARKETS_PER_DAY`, default 5, a day, with results after `AUTO_MARKET_HOURS`, default 72). Results for admin-run markets have a "Use live price" button too.

Telegram alerts: create a bot with @BotFather, set `TELEGRAM_BOT_TOKEN` on the server, then in Admin → Settings send the shown code to the bot and click Connect. Alerts go out for new listings and for markets whose result is due. For players, add the same bot as an admin (with Post Messages) of a public channel and enter its name under **Player channel** in Settings: every published market is posted there with its own banner (the token's logo, ticker, start price and close time, drawn on the server with resvg from a PNG copy of the logo the admin page saves) and a *Predict now* button, a "last hour" reminder with its banner goes out an hour before predictions close, and every result with a winner is posted with a result banner (cancelled markets are not). **Preview Telegram banner** on the market form shows the exact banner before publishing, so a logo from another token with the same ticker is caught. A ticker the banner font can't draw (such as Chinese) gets the fixed banner, and a name it can't draw is left off. **Token banners** in Settings → Player channel switches them off: new markets then use the fixed banner and other posts are text. Settings → Player channel can also post open markets that were never posted, or all of them again. Players then see a Telegram button on market pages, on their dashboard and profile, and in the menu. The server must stay awake for any of this (Render's free plan sleeps, so ping `/api/health` every few minutes).

Set `MANUAL_ONLY=0` to bring back the exchange scanner, live prices and live test markets.

## Quick start

**New here? Follow [START-HERE.md](START-HERE.md)** to run the site with live tokens and real exchange prices before hosting.

Requires **Node.js 22.18 or newer**. Run `npm install` first (three Solana libraries used for TestFPT).

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
  services/firstprint.ts    Accounts, wallets, points ledger, daily streak, markets, detections, settlement
  services/rewards.ts       Tasks, invites, welcome reward and TestFPT claims
  services/telegram.ts      Telegram bot: admin alerts and channel post texts
  services/channel.ts       Player channel posts (banner, results, last-hour reminders)
  services/analytics.ts     Aggregate stats for Admin → Analytics and the partner link
  services/notify.ts        Result emails
  auth/google.ts, mailer.ts Google sign-in, email codes (Resend)
  db/backup.ts              Supabase Storage backup and restore
  solana/testfpt.ts         TestFPT mint and claims
  api/fetchImage.ts         Safe download of admin logo links
  api/server.ts             HTTP API, sessions, SSE stream, admin routes, static site
  demo.ts / demoServer.ts   Isolated read-only public demo service
  exchanges/venues.ts       Binance, MEXC, Bybit, OKX, Gate, Bitget, KuCoin adapters, plus CoinGecko as a price source for trending tokens
  exchanges/sim.ts          Simulated exchange for local development
  workers/listingTracker.ts Announcements and new-pair detection
  workers/liveFeed.ts       Live tickers to Server-Sent Events
  workers/scheduler.ts      Lifecycle, live, and tracker loops
  solana/siws.ts            Sign-In With Solana message and ed25519 verification
  solana/base58.ts
  auth/passwords.ts         scrypt hashing for old password accounts
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
3. `POST /api/auth/wallet/verify` checks the ed25519 signature, the stored message, expiry (5 minutes), and single use. On first sign-in it creates the account (with TestFPT set up, the 1,000 starting points wait as a welcome reward to claim on the Earn page), then sets an HttpOnly session cookie.
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
| POST | `/api/auth/email/start`, `/api/auth/email/verify` | `{ email }`, then `{ email, code }` |
| POST | `/api/auth/google` | `{ credential }` from Google Identity Services |
| POST | `/api/auth/login`, `/api/auth/logout` | Old password accounts; sign out |
| GET | `/api/me` | Points, username, linked wallets |
| POST | `/api/me/profile` | `{ username }` |
| GET, POST | `/api/me/wallets` | List wallets, or link one (same signed-message body) |
| POST | `/api/me/claim-daily` | Streak reward: 50 on day 1, +25 a day, 200 a day from day 7; a missed UTC day resets |
| GET | `/api/me/daily` | Streak, next reward and the last 42 days of claims |
| GET | `/api/me/stats`, `/api/me/ledger`, `/api/me/notifications` | Dashboard numbers, points history, result notifications |
| GET, POST | `/api/me/rewards`, `/api/me/x`, `/api/tasks/:id/start`, `/verify`, `/api/me/claims` | Earn page: rewards, X username, tasks, TestFPT claims |
| GET | `/api/users/:username` | Public profile |
| GET | `/api/public/analytics?key=&days=` | Partner stats (totals only), only with the current share key |
| GET | `/api/me/predictions` | |
| GET | `/api/markets?filter=open\|live\|settled\|all` | |
| GET | `/api/markets/:id` | Includes live price and your predictions |
| GET | `/api/markets/:id/quote?bucket=&stake=` | Estimated payout |
| POST | `/api/markets/:id/predictions` | `{ bucket, stake }` |
| GET | `/api/markets/:id/chart`, `/activity`, `/settlement` | Settlement includes the data hash |
| GET | `/api/listings/detected` | Listing radar (only with `MANUAL_ONLY=0`) |
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
| GET, POST | `/api/admin/manual-markets`, `/:id`, `/:id/publish`, `/unpublish`, `/delete`, `/preview`, `/resolve`, `/start-price` | Admin-run markets (`detectionId` links a New listings entry) |
| POST | `/api/admin/price-check`; GET `/api/admin/market-checks`, `/api/admin/fetch-image?url=` | Live prices, warnings, logo copies |
| POST | `/api/admin/auto-listings` | `{ enabled }` pauses or resumes the new-listing check |
| POST | `/api/admin/telegram/connect`, `/test`, `/channel`, `/post-open`, `/disconnect`; `/api/admin/markets/:id/telegram` | Telegram alerts and the player channel |
| GET, POST | `/api/admin/analytics?days=`, `/api/admin/analytics/share` | Analytics; `{ enabled }` creates a new share link or turns it off |
| GET, POST | `/api/admin/token`, `/api/admin/tasks`, `/api/admin/log` | TestFPT setup, tasks, admin activity |

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
- [ ] Behind Cloudflare, set `BEHIND_CLOUDFLARE=1` so rate limits count each visitor (from `CF-Connecting-IP`) rather than each Cloudflare server. Otherwise set `TRUST_PROXY_HOPS` to the number of proxies in front of the server.
- [ ] Tasks-only team members can add tasks worth up to 500 points; the TestFPT setup and its key are for the owner only.
- [ ] Move to PostgreSQL once traffic grows (`schema.sql` maps directly). Backups already go to Supabase Storage.
- [ ] Add monitoring and alerts for failed tracking, ingestion, or settlement.
- [ ] Get legal advice before points gain any value or real-money pools launch.
- [ ] Check the name "Firstprint" for trademarks and domain availability.

---

Points have no cash value. Firstprint is independent and not affiliated with any exchange. This code is not legal or financial advice.
