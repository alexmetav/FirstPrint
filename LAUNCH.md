# Launch the Firstprint website

The public website source lives in `site/`. Vercel serves the static build and forwards its two read-only API routes to an isolated Render service. The demo has no database and never exposes production prediction writes.

**What visitors get on day 1**
- A landing page covering how it works, the five outcomes, the fairness rules, exchanges, the roadmap, and an FAQ.
- **Try it:** a playable practice market. Visitors pick an outcome, watch 72 hours draw in about four seconds, and build a streak that's saved in their browser.
- **Launch app**, which opens:
  - **Exchanges:** live 24-hour volume, trust scores, trending coins, and the most traded pairs for 13 major exchanges.
  - **Predictions** and **Listing radar**, both marked "Coming soon".

The site has no frontend framework. It installs as an app on phones and keeps showing recent cached data when the provider is temporarily unavailable.

## 1. Edit your settings (2 minutes)

Open `site/assets/config.js` and fill in what you have. Empty values stay hidden on the site.

```js
siteUrl: 'https://yourdomain.com',
links: { x: 'https://x.com/yourhandle', telegram: 'https://t.me/yourgroup', discord: '' },
waitlistUrl: 'https://tally.so/r/yourform',   // optional: adds "Join the waitlist" buttons
```

Once you know your domain, open `site/index.html` and change `og:image` to the full address, for example `https://yourdomain.com/og.png`. Social apps need the full address to show the preview image. Also replace `example.com` in `site/robots.txt` and `site/sitemap.xml` with your domain.

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
