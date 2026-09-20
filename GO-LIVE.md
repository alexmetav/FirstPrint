# Going live

How to turn Firstprint from the practice-mode demo into a public site where
anyone can connect a Solana wallet and earn points on real token predictions.

Points have no cash value. Read **Before you open sign-ups** at the bottom
before sharing the link.

## What changes

Today the public site serves a simulation: `build-deploy.ts` injects
`window.FP_FORCE_DEMO = true`, so `/play` runs `DemoBackend` in the browser on
ten invented tokens with pseudo-random prices, and points reset on reload.

Going live swaps that for the real backend that already exists in `src/`: real
accounts, Sign-In With Solana, a points ledger, markets settled on real exchange
prices, and a shared leaderboard.

## One origin, not two

`web/api.js` calls the API with `credentials: 'same-origin'` and a relative
path, and the session cookie is `SameSite=Lax`. **The app and the API must be on
the same origin.** Serving the static app from Vercel while the API lives on
Render will send no cookie, and every visitor appears logged out immediately
after signing in.

So one Node service serves everything:

```
/            marketing site   (site/)
/play        prediction app   (web/, talking to the real API)
/api/*       the API
```

`npm run build:live` assembles that tree into `.deploy/`, and `WEB_DIR` points
the server at it.

## Deploy

### 1. Check the exchange adapters from a real host

Do this first. If the adapters do not work there are no real prices, every
market voids on `insufficient_baseline_data`, and nothing else matters.

```bash
npm run setup
npm run check
```

Every exchange you plan to use must show `PASS`. These adapters have never been
verified against the live APIs — the fixture tests cover parsing only, and the
README says so. Expect to fix response-format differences.

- Binance blocks some countries, including the US. Drop `binance` from
  `TRACK_VENUES` if it fails.
- Run this from the same network as the deployed server; a host that works
  locally may be geo-blocked in your hosting region.

### 2. Deploy the web service

`render.yaml` already defines it. The important parts:

| Setting | Value | Why |
|---|---|---|
| plan | `starter` or higher | **Not free.** Free instances sleep and have an ephemeral filesystem, so the SQLite file — every account and point balance — is wiped on restart. |
| disk | mounted at `/var/data` | Makes balances survive restarts and redeploys. |
| `DB_PATH` | `/var/data/firstprint.db` | On the disk, not the container. |
| `WEB_DIR` | `./.deploy` | Serve site + app from this origin. |
| `TRUST_PROXY` | `1` | Render forwards one hop. Without it every visitor shares one rate-limit bucket and one busy minute throttles the whole site. Production refuses to start at `0`. |
| `NODE_ENV` | `production` | Enables `Secure` cookies and the startup guards. |
| `PUBLIC_URL` | `https://yourdomain` | Appears in the wallet signing prompt and gates cross-origin writes. Must match the real URL. |
| `ADMIN_KEY` | 24+ random chars | Set in the dashboard, never in git. `openssl rand -hex 32`. |

### 3. Open markets

A live site with no markets is an empty app. Markets come from two places:

**Live test markets on tokens that already trade** — the fastest way to have
something real running. From `/play/#/admin` with your admin key, choose
**Create all (15 min)**, or:

```bash
npm run live                    # suggested tokens, 15-minute markets
npm run live -- SOL BTC ETH
npm run live -- --length=hour SOL
```

These use real prices from every exchange quoting the token and are labelled
"Live test" on the site.

**Real new listings** — set `TRACK_VENUES` to the exchanges that passed step 1.
The tracker then files detections for admin approval at `/play/#/admin`.
`AUTO_CREATE_MARKETS=1` opens them without approval; leave it at `0` until
you have watched the tracker produce correct symbols and times for a while,
because a mis-parsed announcement becomes a real market users can stake on.

Nothing schedules markets for you. Plan on either a recurring `npm run live`
(cron) or an admin checking the radar, or the app will empty out.

### 4. Verify on the real host

```bash
curl https://yourdomain/api/health
```

Then in a browser: connect a wallet on `/play`, pick a username, stake on a
15-minute market, and confirm the live price badge ticks, the market settles,
and points and the leaderboard update. Also confirm **Cancel and refund** in
admin returns everyone's points.

## Running it locally first

```bash
npm run build:live
WEB_DIR=./.deploy npm run dev
# http://localhost:8787  → site,  /play → real app,  /play/#/admin → admin
```

`TRUST_PROXY` stays `0` locally — there is no proxy in front of you.

## Before you open sign-ups

- **`npm run check` passes** for every exchange in `TRACK_VENUES`. Untested
  adapters mean every market voids.
- **Paid plan with a mounted disk.** On free hosting the first restart deletes
  every account.
- **`TRUST_PROXY=1`.** Production will not boot without it, by design.
- **Back up the database.** One file on one disk is one failure away from
  losing every balance. Copy it off the host on a schedule.
- **Legal.** Prediction markets on price movements are regulated as gambling or
  derivatives in many countries. Points that cannot be bought, sold, or redeemed
  is the conservative position you are in now; get advice before that changes.
  Do not accept real money, and do not launch the Solana pools, until the
  program is audited and cleared — see `solana/README.md`.
- **The on-chain program is unaudited and devnet only.** Going live with points
  does not involve it.

## Known gaps

Open items from the code review that are not fixed yet:

- The live feed polls markets sequentially and reloads each market's full view
  every tick; it will hit exchange rate limits somewhere around 20 live markets.
- The settlement `data_hash` cannot be reproduced from the public
  `/api/markets/:id/settlement` response, so the verifiability claim does not
  hold yet.
- Markets cancelled before close display a pool of 0 (refunds are correct).
- `retract()` and `addHalt()` validate neither the market's existence nor its
  status.
- On-chain: fee and early-bird are read live from `Config` instead of being
  snapshotted per market, and there is no permissionless escape hatch if the
  oracle key is lost.
