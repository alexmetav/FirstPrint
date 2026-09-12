# Firstprint on Solana

An Anchor program for **on-chain prediction pools** (USDC or any SPL token), matching the Firstprint off-chain engine:

- Five outcome buckets per market: 0 Crash, 1 Down, 2 Flat, 3 Up, 4 Moon.
- Stakes sit in a vault owned by the market PDA. No one, including the admin, can withdraw them except through `claim`.
- Earlier predictions get up to `1 + early_bird_bps / 10_000` weight.
- The oracle (the Firstprint settlement service) posts the winning bucket, the return in basis points, and the sha256 hash of the price data. Anyone can compare that hash with `GET /api/markets/:id/settlement`.
- Markets with no winners or only one outcome picked become void automatically. The oracle or admin can void a market for delays, retractions, halts, or bad data. Void markets refund every stake in full.

> ⚠️ **Unaudited. Devnet only.** This code has not been compiled or run in the environment where it was written. Build and test it, get a professional audit, and get legal clearance in every jurisdiction before accepting real money.

## Instructions

| Instruction | Signer | Purpose |
|---|---|---|
| `initialize_config(oracle, treasury, fee_bps, early_bird_bps)` | admin | One-time setup |
| `update_config(...)` | admin | Change oracle, treasury, fee, bonus; pause predictions |
| `create_market(id, listing_at, close_at, settle_at, soft_cap, user_cap)` | admin | Opens a market and its vault |
| `place_prediction(bucket, amount)` | user | Transfers tokens into the vault |
| `settle(winning_bucket, return_bps, data_hash)` | oracle | After `settle_at`; takes the fee |
| `void_market(reason)` | oracle or admin | Cancels an open market |
| `claim()` | user | Payout for winners, refund for void markets |

PDAs: `["config"]`, `["market", id]`, `["vault", market]`, `["position", market, user]`. The on-chain `id` is the first 16 bytes of `sha256(firstprint market id)`.

## Build and test

Requires Rust, the Solana CLI (Agave 1.18+ or 2.x), Anchor 0.30.1, and Node 18+.

```bash
cd solana
npm install
anchor keys sync      # generates your program id and updates declare_id! and Anchor.toml
anchor build
cargo test            # math unit tests
anchor test           # local validator: settle + payout, void + refund, oracle-only settlement
```

Deploy to devnet:

```bash
solana config set --url devnet
anchor deploy --provider.cluster devnet
```

## Oracle

`oracle/settle.ts` reads settlements from the Firstprint API and posts them on-chain:

```bash
FIRSTPRINT_API=https://your-site RPC_URL=https://api.devnet.solana.com \
ORACLE_KEYPAIR=~/.config/solana/oracle.json USDC_MINT=<mint> TREASURY=<treasury owner> \
npm run oracle -- <market id> [<market id> ...]
```

Keep the oracle key separate from the admin key, and consider a multisig (for example Squads) for admin actions.

## Differences from the off-chain engine

- The volume-based hard cap and latest-first refunds at close are enforced off-chain only. On-chain, the pool cap and per-user cap apply at prediction time, and the oracle can void a market it believes was manipulated.
- Rounding dust stays in the vault. Add a sweep instruction after a claim deadline if needed.
