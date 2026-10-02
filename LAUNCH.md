# Launch the Firstprint website

The public website source lives in `site/`. Vercel serves the static build and forwards its two read-only API routes to an isolated Render service. The demo has no database and never exposes production prediction writes.

**What visitors get on day 1**
- A landing page covering how it works, the five outcomes, the fairness rules, exchanges, the roadmap, and an FAQ.
- **Try it:** a playable practice market. Visitors pick an outcome, watch 72 hours draw in about four seconds, and build a streak that's saved in their browser.
- **Exchanges:** live 24-hour volume, trust scores, trending coins, and the most traded pairs for 13 major exchanges.
- **Try practice beta** (`/play/`): the prediction app in practice mode, with simulated prices and free points kept in the visitor's browser. Set `APP_URL` when building to point these links at the hosted full app instead (see `scripts/build-deploy.ts`).

The site has no frontend framework. It installs as an app on phones and keeps showing recent cached data when the provider is temporarily unavailable.

## 1. Edit your settings (2 minutes)

Open `site/assets/config.js` and fill in what you have. Empty values stay hidden on the site.

```js
siteUrl: 'https://yourdomain.com',
links: { x: 'https://x.com/yourhandle', telegram: 'https://t.me/yourgroup', discord: '' },
waitlistUrl: 'https://tally.so/r/yourform',   // optional: adds "Join the waitlist" buttons
```

The site is set up for `https://www.firstprint.fun`: the full `og:image` address in `site/index.html` (social apps need it to show the preview image) and `site/robots.txt` and `site/sitemap.xml`. If the domain changes, update those three.

Security headers (Content-Security-Policy, HSTS and others) and cache rules are set in `vercel.json`; the app server sends the same policy, and a test keeps the two in step.

## 2. Deploy the read-only API

1. In Render, create a Blueprint from this repository. Render reads `render.yaml` and creates `firstprint-demo-api`.
2. Optionally add a CoinGecko demo key as the private `COINGECKO_API_KEY` value.
3. Confirm `https://firstprint-demo-api.onrender.com/api/health` returns `mode: "read-only-demo"`.
4. If Render assigns a different hostname, update both destinations in the root `vercel.json`.

## 3. Deploy the site

1. In Vercel, import this repository from GitHub.
2. Leave the project root at the repository root. The checked-in `vercel.json` supplies the build command, output directory, security headers, and read-only API rewrites.
3. Deploy and confirm `/api/health` works through the Vercel URL.

Netlify or Cloudflare can host the static files only if you separately reproduce the two same-origin API proxy rules. Direct browser calls to CoinGecko are intentionally unsupported.

## 4. Check before you share it

- [ ] The landing page loads on desktop and phone.
- [ ] **Launch app** shows exchanges with live volume and a green "Live data" note.
- [ ] Opening an exchange shows its most traded pairs.
- [ ] Your social and waitlist links work.
- [ ] Sharing the link shows the preview image (check with a link preview tool).
- [ ] The practice market in the "Try it" section runs and keeps your streak after a reload.
- [ ] `/play/` displays the practice-only banner and never creates a network request to prediction or authentication routes.
- [ ] On a phone, "Add to Home Screen" installs it with the Firstprint icon.

If exchange data shows "couldn't load", check the read-only Render service and its private `COINGECKO_API_KEY`. Never add a provider key to `config.js` or any browser asset.

## Day-by-day plan

| When | Goal | What to do |
|---|---|---|
| Day 1 | Read-only demo live | Deploy the Render Blueprint and Vercel build, connect your domain, then verify the proxy |
| Day 2 | Audience | Set up X and Telegram, add a waitlist form, add privacy-friendly analytics |
| Days 3–4 | Full backend staging | Migrate persistence to PostgreSQL, run `npm run check` from the hosting region, and keep prediction writes private |
| Days 5–6 | Listing radar | Switch the Radar tab from "Coming soon" to live detections from the backend |
| Days 7–10 | Predictions beta | Turn on wallet sign-in and points, and run 15-minute live test markets with early users |
| Week 3 | Real listing markets | Approve detected listings into 72-hour markets, then add leaderboards |
| Later | On Solana | On-chain pools only after a security audit and legal review |

Each step builds on code already in this repo:
- `src/` is the backend.
- `web/` is the full prediction app.
- `solana/` is the on-chain program.

We'll connect each piece to the public site as you reach it.

## Launch the full app (accounts, points, admin panel, markets), free

The static site and the read-only demo above don't have accounts. The full app is a second Render service, `firstprint-app`, defined in `render.yaml`. It needs **no payment**: it runs on Render's free plan and keeps its database safe in a free Supabase Storage bucket.

**How the database survives.** Render's free plan wipes the disk whenever the server restarts or goes to sleep. So the server restores its database from Supabase when it starts, saves a copy every minute if anything changed, and saves once more when Render shuts it down. The admin page shows when the last copy was saved. If the saved copy exists but can't be downloaded, the server refuses to start rather than begin empty and overwrite it. It also keeps one dated copy per day. At most the last minute of activity can be lost if the server is killed without warning.

**Free-plan limits to know about.** The server sleeps after 15 minutes without visits and takes about a minute to wake up. It must stay a single instance. When it wakes, markets whose timer ended close on the first tick. Both free Render services share 750 hours a month, so keeping this one awake around the clock would leave the demo API asleep.

### Steps

1. **Supabase (free):** at supabase.com create a project named `firstprint`. Then **Storage → New bucket**, name `firstprint-backups`, and leave **Public bucket off**. Under **Project Settings → API** copy the **Project URL** and the **service_role** key. That key is a secret: only ever paste it into Render, never into chat or the repo.
2. **Render:** open the Blueprint for this repository and apply the update, which adds `firstprint-app`. Render asks for the values marked "sync: false":
   - `PUBLIC_URL`: the address people will type, no trailing slash, e.g. `https://app.firstprint.fun`. It must match exactly, or wallet sign-in fails.
   - `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` from step 1.
   - `GOOGLE_CLIENT_ID`, `RESEND_API_KEY`, `MAIL_FROM`: optional. Leave one blank and that option stays hidden. See the README under "Signing in".
3. Wait for the deploy to go green, then open `https://<service>.onrender.com/api/health`. It should return `{"ok":true,...}`.
4. Read the generated admin key in Render → `firstprint-app` → Environment → `ADMIN_KEY`. Open `<your app address>/#/admin` and paste it. The page should say "Database backup: last saved ...". Keep the key private.
5. Custom domain: in Render → Settings → Custom Domains add `app.firstprint.fun`, then add the DNS record Render shows you. Set `PUBLIC_URL` to that address and redeploy.
6. Point the marketing site at it: in Vercel → Settings → Environment Variables add `APP_URL` = your app address (`https://...`), then redeploy. The "practice" buttons on the site then open the full app. Without `APP_URL` the site keeps linking to the browser-only practice build at `/play/`.
7. Google only: in Google Cloud Console add your `PUBLIC_URL` as an Authorized JavaScript origin on the OAuth client.

**What's free and what isn't.** Wallet and Google sign-in are free. Email codes work without payment only to your own address in Resend's test mode; sending to everyone needs a domain verified in Resend, which uses a domain you own (you already own firstprint.fun, so it costs nothing extra). To try the app before that, sign in with a Solana wallet (devnet by default).

Upgrading later: for a persistent disk instead of backups, see the comment in `render.yaml`. Moving to PostgreSQL (BACKEND-SETUP.md) is only needed for more than one instance.
