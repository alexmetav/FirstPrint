# Launch the Firstprint website

The public website source lives in `site/`, and the prediction app in `web/`. The full app on Render (`firstprint-app`, below) serves both: the landing page at `/` and the app at `/app/`, so pointing your domain at Render is all you need.

**What visitors see**
- A landing page: how it works, the five outcomes, the fairness rules, free points and the dashboard, the roadmap and an FAQ.
- **Try it:** a quick practice round with a made-up token and a random result. The streak is kept in the visitor's browser.
- **Launch app** buttons that open the markets at `/app/`.
- A privacy policy at `/privacy.html` and terms at `/terms.html`.

The site has no frontend framework and installs as an app on phones.

## 1. Edit your settings (2 minutes)

Open `site/assets/config.js` and fill in what you have. Empty values stay hidden on the site.

```js
siteUrl: 'https://yourdomain.com',
links: { x: 'https://x.com/yourhandle', telegram: 'https://t.me/yourgroup', discord: '' },
waitlistUrl: 'https://tally.so/r/yourform',   // optional: adds "Join the waitlist" buttons
```

The site is set up for `https://www.firstprint.fun`: the canonical and `og:image` addresses in `site/index.html`, and `site/robots.txt` and `site/sitemap.xml`. If the domain changes, update those.

Security headers (Content-Security-Policy, HSTS and others) are sent by the app server; `vercel.json` sends the same policy for the Vercel copy, and a test keeps the two in step.

## 2. Optional: a copy on Vercel

Vercel can also host the website (`vercel.json` builds it with `npm run build:deploy`). Without `APP_URL` its buttons open `/play/`, a browser-only practice copy of the app with simulated prices. Set `APP_URL` to your app address plus `/app` (for example `https://firstprint-app.onrender.com/app`) to send them to the real app instead.

## 3. Check before you share it

- [ ] The landing page loads on desktop and phone, and **Launch app** opens the markets.
- [ ] You can sign in, place a prediction and see it on your dashboard.
- [ ] Your social and waitlist links work.
- [ ] Sharing the link shows the preview image (check with a link preview tool).
- [ ] The "Try it" practice round runs and keeps your streak after a reload.
- [ ] On a phone, "Add to Home Screen" installs it with the Firstprint icon.

## Launch the full app (accounts, points, admin panel, markets), free

The static site and the read-only demo above don't have accounts. The full app is a second Render service, `firstprint-app`, defined in `render.yaml`. It needs **no payment**: it runs on Render's free plan and keeps its database safe in a free Supabase Storage bucket.

**How the database survives.** Render's free plan wipes the disk whenever the server restarts or goes to sleep. So the server restores its database from Supabase when it starts, saves a compressed copy every 5 minutes if anything changed, and saves once more when Render shuts it down. The admin page shows when the last copy was saved. If the saved copy exists but can't be downloaded, the server refuses to start rather than begin empty and overwrite it. It also keeps one dated copy per day for the last 7 days. At most the last 5 minutes of activity can be lost if the server is killed without warning. During a deploy Render briefly runs the old and new server side by side, so deploy at a quiet time: predictions made in that minute or two can be lost.

**Free-plan limits to know about.** The server sleeps after 15 minutes without visits and takes about a minute to wake up. While it sleeps, the MEXC new-listing check, Telegram alerts, channel posts and last-hour reminders don't run, so ping `/api/health` every 5 minutes (for example with UptimeRobot, free). It must stay a single instance. When it wakes, markets whose timer ended close on the first tick. Both free Render services share 750 hours a month, so keeping this one awake around the clock would leave the demo API asleep.

### Steps

1. **Supabase (free):** at supabase.com create a project named `firstprint`. Then **Storage → New bucket**, name `firstprint-backups`, and leave **Public bucket off**. Under **Project Settings → API** copy the **Project URL** and the **service_role** key. That key is a secret: only ever paste it into Render, never into chat or the repo.
2. **Render:** open the Blueprint for this repository and apply the update, which adds `firstprint-app`. Render asks for the values marked "sync: false":
   - `PUBLIC_URL`: the address people will type, no trailing slash, e.g. `https://firstprint.fun` when the domain points at this service (it serves both the website and `/app/`). It must match exactly, or wallet sign-in fails.
   - `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` from step 1.
   - `GOOGLE_CLIENT_ID`, `RESEND_API_KEY`, `MAIL_FROM`: optional. Leave one blank and that option stays hidden. See the README under "Signing in".
   - `TELEGRAM_BOT_TOKEN`: optional, from @BotFather. Turns on admin alerts and the player channel (see *Telegram* below).
   - New MEXC listings go to Admin → New listings by default. `AUTO_LISTINGS=0` turns the check off; `AUTO_LISTINGS=publish` opens self-settling markets instead (`AUTO_MARKETS_PER_DAY`, `AUTO_MARKET_HOURS`).
3. Wait for the deploy to go green, then open `https://<service>.onrender.com/api/health`. It should return `{"ok":true,...}`.
4. Read the generated admin key in Render → `firstprint-app` → Environment → `ADMIN_KEY`. Open `<your app address>/#/admin` and paste it. The page should say "Database backup: last saved ...". Keep the key private.
5. Custom domain: in Render → Settings → Custom Domains add your domain (for example `firstprint.fun`), then add the DNS record Render shows you. Set `PUBLIC_URL` to that address and redeploy.
6. **The app serves the website too.** `firstprint-app` shows the landing page at `/` and the app at `/app/`; the landing page's **Launch app** buttons open `/app/`. So pointing your domain straight at Render gives visitors the landing page first. Old links such as `/#/market/...` and `/#/admin` forward to the same page under `/app/`. Set `SITE=0` to serve only the app at `/`.
7. If the website stays on Vercel instead:  in Vercel → Settings → Environment Variables add `APP_URL` = your app address plus `/app` (for example `https://firstprint-app.onrender.com/app`), then redeploy. The "practice" buttons on the site then open the full app. Without `APP_URL` the site keeps linking to the browser-only practice build at `/play/`.
8. Google only: in Google Cloud Console add your `PUBLIC_URL` as an Authorized JavaScript origin on the OAuth client.

### Telegram: admin alerts and the player channel

1. In Telegram, open **@BotFather**, send `/newbot` and follow the steps. Put the token in Render as `TELEGRAM_BOT_TOKEN` (never in chat or the repo).
2. **Your alerts:** Admin → Settings → Telegram alerts shows a code. Send it to your bot, then press **Connect**. You get a message for every new MEXC listing and every market that closes and needs a result.
3. **Player channel:** create a public channel, add the bot as an admin with **Post Messages**, and enter the channel name under **Player channel**. Every market you publish is posted with its own banner (the token's logo and ticker, drawn automatically) and a **Predict now** button, a "last hour" reminder goes out an hour before predictions close, and results with a winner are posted. **Post all now** posts open markets made before the channel was set up. Players see a Telegram button on market pages, their dashboard and the menu.

### Analytics for partners

Admin → **Analytics** shows players, active players, predictions, points staked, sign-in methods, daily streaks and the most played markets for 7, 30 or 90 days. **Create a share link** gives a read-only page (`/app/#/stats/<key>`) with totals only, no names, emails or wallets. **New link** stops the old one; **Turn off** ends sharing.

### TestFPT, tasks and invites

Players' starting points (1,000) and rewards from tasks and invites (not daily points or winnings, which stay in the Firstprint balance) are claimed to their own Solana wallet as **TestFPT**, a Token-2022 token on Solana **testnet** (set `TOKEN_CLUSTER=devnet` for devnet). The player signs the claim and pays the tiny network fee in free test SOL from https://faucet.solana.com; the app walks them through it.

Set it up once in the admin panel (`/app/#/admin` → **TestFPT token**):
1. **Create authority.** The server makes the key that mints TestFPT and stores it in its database (which is backed up privately). Copy its address.
2. **Give it test SOL.** Paste the address into https://faucet.solana.com (choose Testnet), or press **Request 1 SOL**. Press **Refresh balance**.
3. **Create TestFPT.** The token is created on chain with its name and 0 decimals (1 point = 1 TestFPT).

Until step 3, rewards go straight to players' balances as before. To use your own key instead, set `TESTFPT_AUTHORITY_KEY` (a solana-keygen JSON array) and, once created, `TESTFPT_MINT`. `SOLANA_RPC_URL` overrides the public RPC.

**Tasks** (admin → **Tasks**): follow an X account, repost or like a post, post about Firstprint (the player's invite link is added), or visit a link, each with points and an optional player limit. X has no free API for checking follows or reposts, so tasks are honour-based: the player links their X username (one account per username), opens the task, and presses Verify after a few seconds. Linking an X username gives 100 points. **Invites:** a player earns 200 points when a friend signs up with their link and makes a first prediction, up to 25 friends.

**What's free and what isn't.** Wallet and Google sign-in are free. Email codes work without payment only to your own address in Resend's test mode; sending to everyone needs a domain verified in Resend, which uses a domain you own (you already own firstprint.fun, so it costs nothing extra). To try the app before that, sign in with a Solana wallet (devnet by default).

Upgrading later: for a persistent disk instead of backups, see the comment in `render.yaml`. Moving to PostgreSQL (BACKEND-SETUP.md) is only needed for more than one instance.
