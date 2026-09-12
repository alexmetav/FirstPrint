# Start here: test Firstprint with live tokens

This guide runs the full site on your computer with **real exchange prices**, so you can check everything before hosting. It takes about 10 minutes, plus 15–20 minutes to watch a market settle.

## What you need

- A computer (Windows, Mac, or Linux) with internet access.
- **Node.js 22.18 or newer.** Download the LTS version from [nodejs.org](https://nodejs.org). Check it by running `node -v` in a terminal.
- A Solana wallet browser extension, such as [Phantom](https://phantom.com/download), [Solflare](https://solflare.com/download), or [Backpack](https://backpack.app/download). You don't need any SOL or tokens, because sign-in only signs a message.

## Steps

**1. Unzip and open a terminal in the folder**

Unzip `firstprint.zip`, then open a terminal inside the `firstprint` folder.
- Windows: open the folder, click the address bar, type `cmd`, and press Enter.
- Mac: right-click the folder and choose "New Terminal at Folder".

**2. Set up**

```bash
npm run setup
```

This creates your `.env` settings file and prints an **admin key**. Copy the key somewhere safe.

**3. Check the exchange connections**

```bash
npm run check
```

Every exchange should show `PASS`. If one fails:
- Binance blocks some countries, including the US. Remove `binance` from `TRACK_VENUES` in `.env`.
- A VPN, firewall, or office network can block exchange APIs. Try another network.

**4. Start the site**

```bash
npm run dev
```

Open **http://localhost:8787** in the browser that has your wallet. Leave this terminal running.

**5. Create live markets**

Open **http://localhost:8787/#/admin**, paste your admin key, and choose **Create all (15 min)**. You'll get markets on recently listed tokens and on SOL, BTC, and ETH, using live prices from every exchange that trades them. Tokens with no live price are skipped, and the page tells you why.

You can also type any token symbol, pick exchanges, a start time, and a length (15 minutes, 1 hour, 24 hours, or 72 hours).

Prefer the terminal? Open a second terminal in the same folder and run:

```bash
npm run live                      # suggested tokens, 15-minute markets
npm run live -- SOL HYPE TAO      # your own list
npm run live -- --length=hour SOL
```

**6. Test as a user**

1. Go to **Markets** and choose **Connect wallet**. Approve the sign-in message in your wallet.
2. Pick a username. You start with 1,000 points.
3. Open a market, pick an outcome, and choose **Predict**. You have 2 minutes before a market starts, plus 3 more minutes after it starts.
4. After the market starts, check that the **Live price** badge and chart update every few seconds.
5. About 15 minutes after the start, the market settles. Check the result, your points in **Portfolio**, and the **Leaderboard**.

**7. Check the listing radar**

In Admin, choose **Scan exchanges now**. Real upcoming listings from exchange announcements appear under **Detected listings** and on the public **Listing radar** page. Enter the trading start time and choose **Open market** to create a real listing market.

## What to check before hosting

- [ ] `npm run check` passes for every exchange you plan to use.
- [ ] Wallet sign-in works in each wallet you want to support.
- [ ] A 15-minute market settles, and points and the leaderboard update.
- [ ] **Cancel and refund** in Admin returns everyone's points.
- [ ] Listing scans find real announcements, and approving one opens a market.
- [ ] The site works on your phone. Open it inside your wallet app's browser to connect.

## If something goes wrong

| Problem | Fix |
|---|---|
| `node: bad option` or TypeScript errors on start | Update Node.js to 22.18 or newer |
| "No Solana wallet found" | Install a wallet extension and reload the page |
| A market was cancelled for "not enough trading data" | The token traded too rarely during the market. Use a more active token or a longer length |
| Port 8787 is in use | Change `PORT` in `.env` |
| Start fresh | Stop the server, delete the `data` folder, and run `npm run dev` again |

To practise offline without exchange data, set `SIM=1` in `.env`, run `npm run seed`, and start the site.

When you're ready to host, follow **Before going live** in `README.md`.
