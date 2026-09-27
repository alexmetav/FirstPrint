# Testing every function before launch

Run the real product on your own computer, with real exchange prices and your
real wallet, and work through the checklist. This is the same code that deploys,
so anything that passes here will behave the same on a server, apart from the
three items under **Only testable on a real host** at the end.

## Start it

Two commands. No files to edit.

```bash
npm run setup        # once — creates .env and prints your admin key. Copy the key.
npm run dev
```

Open **http://localhost:8787** — that is the real app, on real prices.
Admin is at **http://localhost:8787/#/admin**; paste the key `npm run setup` printed.

Leave that terminal running. It restarts by itself when files change, and
`Ctrl+C` stops it.

<details>
<summary>Optional: also see the marketing site, exactly as it deploys</summary>

The two commands above serve the app by itself at `/`. To get the layout the
server uses in production — marketing site at `/`, app at `/play` — run
`npm run build:live`, add `WEB_DIR=./.deploy` to `.env`, and restart. Every
check below then lives under `/play` instead of `/`. Worth doing once before
launch; not needed to test the functions.

</details>

## Create something to test against

Predictions need a market. In a **second terminal**, in the same folder:

```bash
npm run live                      # 15-minute markets on suggested tokens
npm run live -- SOL BTC ETH       # pick your own
npm run live -- --length=hour SOL # 1 hour instead of 15 minutes
```

Or from **http://localhost:8787/#/admin**, choose **Create all (15 min)**.

A 15-minute market is the fastest way to see a full cycle: predictions open,
trading starts, predictions close, it settles, points move.

## Checklist

### Accounts and wallet

- [ ] The app loads with no "practice mode" banner (if you see one you are on the
      simulation, not the real backend — stop and check you ran `npm run dev`)
- [ ] **Connect wallet** lists your installed wallets (Phantom, Solflare, Backpack)
- [ ] Approving the signature signs you in — no transaction, no fee requested
- [ ] The signing prompt shows `localhost:8787` as the site
- [ ] First sign-in asks you to pick a username
- [ ] You start with 1,000 points
- [ ] Reload the page — still signed in, points unchanged
- [ ] **Log out**, then sign in again with the same wallet — same account, same points, not a new one
- [ ] Rejecting the signature in the wallet shows an error and does not sign you in
- [ ] Email signup and login also work (the fallback path)
- [ ] From **Portfolio**, link a second wallet to the same account
- [ ] Trying to link a wallet already attached to another account is refused

### Points

- [ ] **Claim daily** adds 100 points
- [ ] Claiming twice on the same day is refused
- [ ] Balance in the header matches Portfolio

### Earn-points tasks (Portfolio → Earn points)

- [ ] Six tasks are listed, with a tick on the ones you have already done
- [ ] A finished task shows a **Collect** button; an unfinished one shows only its points
- [ ] Collecting adds exactly that many points and the row turns to "Collected"
- [ ] The same task cannot be collected twice
- [ ] Making your first prediction turns on **Make your first prediction**
- [ ] Predicting on three separate markets turns on **Predict on three different markets**
- [ ] Linking a second wallet turns on **Link a second wallet**
- [ ] After a market you predicted on settles, **See a market settle** turns on

### Predicting

- [ ] A market page shows the five outcomes with their percentage ranges
- [ ] Picking an outcome and a stake shows an estimated payout before you commit
- [ ] Predicting deducts the stake from your balance immediately
- [ ] The market's pool and predictor count go up
- [ ] Your prediction appears under your positions and in **Recent activity**
- [ ] A stake below 10 points is refused
- [ ] A stake above your balance is refused
- [ ] A stake above the per-market user cap is refused, and the message says how much is left
- [ ] Predicting after the close time is refused

### Live prices — the part that matters most

- [ ] Once trading starts, a **Live price** badge appears and updates every few seconds
- [ ] The chart draws and keeps extending
- [ ] The projected outcome changes as the price moves
- [ ] The price roughly matches what the exchange's own site shows for that token
- [ ] The market page names the real exchanges it is pricing from (not "Simulator")

### Settlement — watch one all the way through

- [ ] At the close time the market stops accepting predictions
- [ ] At the settle time it resolves to an outcome
- [ ] The winning outcome matches the price move shown
- [ ] Winners' points increase; losers' stakes are gone
- [ ] **Portfolio** shows the result per prediction
- [ ] **Leaderboard** updates
- [ ] The settlement page shows the prices and windows used

### Admin

- [ ] The admin page rejects a wrong key
- [ ] **Scan exchanges now** returns PASS for every exchange you plan to use
- [ ] **Create all (15 min)** opens markets; tokens with no live price are skipped with a reason
- [ ] **Cancel and refund** on a market with predictions returns everyone's points in full
- [ ] A cancelled market shows the pool that was actually staked, not 0
- [ ] Cancelling an already-settled market is refused
- [ ] **Scan for listings** finds real announcements (needs `TRACK_VENUES` set in `.env`)
- [ ] Approving a detected listing with a trading start time opens a market

### General

- [ ] Works on your phone on the same wifi (use your computer's local IP instead of localhost)
- [ ] Refreshing mid-session never loses your balance
- [ ] Stopping and restarting the server keeps all accounts and points
- [ ] No red errors in the browser console (F12 → Console)

## Only testable on a real host

These cannot be checked from localhost:

1. **Exchanges from the hosting region.** They passed from your machine, but
   exchanges block by country and your server may sit elsewhere. Run
   `npm run check` on the server before opening sign-ups.
2. **HTTPS and secure cookies.** `NODE_ENV=production` sets the `Secure` flag,
   which needs real HTTPS.
3. **Mobile wallet apps.** Connecting inside Phantom's or Solflare's in-app
   browser needs a public URL.

## Reporting a problem

For anything that fails, the useful details are:

- Which checklist line
- What you expected vs what happened
- Any red text in the browser console (F12 → Console)
- The last few lines from the terminal running `npm run dev`

The terminal log is usually the most informative — server errors are printed
there with a timestamp.

## Known gaps, already documented

Not bugs to report — these are on the list in `GO-LIVE.md`:

- The live price feed polls markets one at a time and will strain past roughly
  20 simultaneous live markets.
- The settlement data hash cannot yet be reproduced from the public settlement
  endpoint, so that verifiability claim does not hold.
- Nothing schedules markets automatically. Without `npm run live` on a timer or
  an admin approving listings, the app empties out.
