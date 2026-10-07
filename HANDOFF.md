# Handoff for the next Claude session

Read this first. It sums up where Firstprint stands and how to work with the owner.

## How to work with the owner

- **Language.** Reply in simple Hinglish. The owner is not a developer, so explain in plain words what changed and what to click.
- **Branch.** Work on the branch the session gives you. Never push to `main` directly.
- **"merge it".** When the owner says it:
  1. Open a PR.
  2. Wait for the `verify` check to pass.
  3. Squash-merge, using the full 40-character head SHA as `expectedHeadSha`.
  4. Reset the working branch to the new `main`.
  Before every push, also run `npm run build:web && npm run build:site`. CI fails if the committed `dist/` preview is out of date.
- **Secrets.** Never ask the owner to paste a secret in chat. That covers keys, tokens, `ADMIN_KEY`, `WALLET_ENCRYPTION_KEY`, the TestFPT authority key, and the Supabase, Resend, CoinGecko and GetXAPI keys. They go only into Render → Environment. **Never change or delete `WALLET_ENCRYPTION_KEY`**: players' Firstprint wallets depend on it.
- **Numbers.** Never invent traction numbers. Real numbers come from Admin → Analytics.
- **Network.** The cloud session may not be able to reach `firstprint.fun`. In that case, ask the owner to check the live site.

## Product today

- Firstprint is a free prediction game. Players pick where a token's price lands: Moon, Up, Flat, Down or Crash, or Yes/No.
- The testnet is live on Solana. Points move as the TestFPT test token, sent straight to players' wallets, and the server pays the network fee.
- Hosting: Render (`firstprint-app`) behind Cloudflare. SQLite database, backed up to Supabase Storage.

**Recently shipped (#96–#104)**
- Safe deploys and the Admin → Errors panel.
- Fixes for heavy traffic.
- A big live countdown on market pages.
- Rewards sent straight to the wallet.
- A claim chip in the top bar.
- Task reset and delete.
- Home banner: Total markets and Top payout (the best multiple actually paid, counting up in green).
- Admin → Markets: Old results (CSV download, Clear / Clear all) and pages.
- Admin → User activity.
- Admin → TestFPT shows the **Fee wallet** (send test SOL there). The **mint address must never receive SOL**: SOL sent there is stuck for good.

## Before the public testnet push (owner's checklist)

1. **Render.** Upgrade to Standard, or Pro for launch week. Add a persistent disk (1–5 GB), then move the database onto it (code task).
2. **Resend.** Upgrade to Pro. The free plan allows 100 emails a day; after that, email sign-in stops working.
3. **Google sign-in.** Make sure `GOOGLE_CLIENT_ID` is set.
4. **GetXAPI.** Top up $100–300 of credit for X task checks.
5. **Test SOL.** About 0.002 SOL is needed per new wallet. The owner must pick one option:
   - (a) send only the welcome bonus on chain;
   - (b) move TestFPT to devnet;
   - (c) cap on-chain sends per hour.
6. **Uptime.** Add an UptimeRobot monitor on `/api/health`.
7. **Settings.** Set `MAX_STREAMS=20000` once on Standard or Pro. Raise `NEW_ACCOUNTS_PER_DAY` if Admin → Errors shows `too_many_accounts`.
8. **Costs.**
   - About $106 a month: Render Pro $85, disk about $1, Resend Pro $20.
   - Plus GetXAPI credit.
   - Supabase Pro ($25) only when backups near 1 GB or 50 MB per file.
   - Cloudflare free is enough.

## Code work still open (ask the owner which first)

1. Cache odds, holders and the featured market for a few seconds.
2. Faster on-chain sends: several at once, or one transaction for many players.
3. Telegram join check through a webhook.
4. Move the database to the Render disk and back it up daily.
5. If the owner wants them: an Ambassador badge or chip in the app, and a Founding Ambassador badge on chain.

## Marketing (`marketing/`)

**Video engine:** `marketing/video/`. `README.md` has the render steps; `STYLE.md` has the approved look.
- Approved style: square, 60 fps; words revealed one by one out of a lens blur; motion blur; real token logos; the green screen wipe on the key tap; only relevant sound effects (no whooshes); a small "Testnet live" pill above the logo on the end card.
- `x1.js` is the approved video 1 and the template for new videos.
- Videos 2–5 still need remaking in this style. The owner gives feedback one video at a time.

**Content:** `marketing/content/`.
- `CONTENT-PACK.md` holds the video 1 tweets, the 7-post ambassador teaser, milestone drafts, the blurb and the launch steps.
- The teaser banners and X headers are in the same folder.
- The owner liked none of the headers made so far: the any-token header, phone close-up, soft gradient, Five Lanes and studio mark. A new concept is still wanted; it must look premium and not copy anyone.

**Ambassador program (draft, waiting on the owner)**
- Tiers: Scout → Caller → Oracle.
- Ideas proposed: "paid to be right, not to shill", own markets at the top tier, a Founding Ambassador badge on chain, monthly seasons, a weekly spotlight, regional leads.
- An FPT allocation can be offered only as "if and when FPT launches, with vesting". Never promise value.
- The owner still has to send: the final perks, whether FPT is offered (and how much), the apply link, the dates and the number of seats. Build the ambassador video after that.

**Blurb**
- The clean, emoji-free version is in the chat history and `CONTENT-PACK.md` section 5.
- Traction numbers and partner names stay as placeholders until the owner gives real ones.
- Never list exchanges or partners without their approval.
