# Launch the Firstprint website

The public website lives in the `site/` folder. It's a static site with no server, no build step, and no database, so you can host it for free in a few minutes.

**What visitors get on day 1**
- A landing page covering how it works, the five outcomes, the fairness rules, exchanges, the roadmap, and an FAQ.
- **Try it:** a playable practice market. Visitors pick an outcome, watch 72 hours draw in about four seconds, and build a streak that's saved in their browser.
- **Launch app**, which opens:
  - **Exchanges:** live 24-hour volume, trust scores, trending coins, and the most traded pairs for 13 major exchanges.
  - **Predictions** and **Listing radar**, both marked "Coming soon".

The whole site is about 26 KB compressed, with no framework and no build step. It installs as an app on phones and keeps showing your last data when the network drops.

## 1. Edit your settings (2 minutes)

Open `site/assets/config.js` and fill in what you have. Empty values stay hidden on the site.

```js
siteUrl: 'https://yourdomain.com',
links: { x: 'https://x.com/yourhandle', telegram: 'https://t.me/yourgroup', discord: '' },
waitlistUrl: 'https://tally.so/r/yourform',   // optional: adds "Join the waitlist" buttons
coingeckoApiKey: '',                            // optional: free demo key for higher limits
```

Once you know your domain, open `site/index.html` and change `og:image` to the full address, for example `https://yourdomain.com/og.png`. Social apps need the full address to show the preview image. Also replace `example.com` in `site/robots.txt` and `site/sitemap.xml` with your domain.

## 2. Put it online (pick one)

**Netlify Drop (fastest, no account setup)**
1. Go to app.netlify.com/drop on a computer.
2. Drag the `site` folder onto the page.
3. Your site is live on a netlify.app address. Add your own domain under **Domain management**.

**Vercel**
1. Push this project to GitHub.
2. In Vercel, choose **Add New Project** and import the repo.
3. Set **Root Directory** to `site`, set **Framework** to **Other**, and leave the build command empty.
4. Deploy.

**Cloudflare Pages**
1. Push to GitHub.
2. Create a Pages project from the repo.
3. Set **Build command** to empty and **Build output directory** to `site`.
4. Deploy.

Every later update is the same: change files in `site/`, then drag the folder again (Netlify Drop) or push to GitHub (Vercel and Cloudflare).

## 3. Check before you share it

- [ ] The landing page loads on desktop and phone.
- [ ] **Launch app** shows exchanges with live volume and a green "Live data" note.
- [ ] Opening an exchange shows its most traded pairs.
- [ ] Your social and waitlist links work.
- [ ] Sharing the link shows the preview image (check with a link preview tool).
- [ ] The practice market in the "Try it" section runs and keeps your streak after a reload.
- [ ] On a phone, "Add to Home Screen" installs it with the Firstprint icon.

If exchange data shows "couldn't load", CoinGecko's free limit was probably reached. Add a free demo key in `config.js`.

## Day-by-day plan

| When | Goal | What to do |
|---|---|---|
| Day 1 | Website live | Deploy `site/`, connect your domain, share the link |
| Day 2 | Audience | Set up X and Telegram, add a waitlist form, add privacy-friendly analytics |
| Days 3–4 | Backend online | Host the Node server (Railway, Render, or Fly.io with a persistent disk), run `npm run check`, keep it private |
| Days 5–6 | Listing radar | Switch the Radar tab from "Coming soon" to live detections from the backend |
| Days 7–10 | Predictions beta | Turn on wallet sign-in and points, and run 15-minute live test markets with early users |
| Week 3 | Real listing markets | Approve detected listings into 72-hour markets, then add leaderboards |
| Later | On Solana | On-chain pools only after a security audit and legal review |

Each step builds on code already in this repo:
- `src/` is the backend.
- `web/` is the full prediction app.
- `solana/` is the on-chain program.

We'll connect each piece to the public site as you reach it.
