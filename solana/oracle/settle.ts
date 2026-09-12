/**
 * Oracle: posts Firstprint settlements to the on-chain program.
 *
 *   FIRSTPRINT_API=https://firstprint.xyz RPC_URL=https://api.devnet.solana.com \
 *   ORACLE_KEYPAIR=~/.config/solana/oracle.json USDC_MINT=<mint> TREASURY=<owner> \
 *   npx ts-node oracle/settle.ts kora-mexc-ab12cd [more market ids...]
 *
 * On-chain market id = first 16 bytes of sha256(Firstprint market id).
 */
import * as anchor from '@coral-xyz/anchor';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import idl from '../target/idl/firstprint_pools.json';

const BUCKET_INDEX: Record<string, number> = { crash: 0, down: 1, flat: 2, up: 3, moon: 4 };
const VOID_CODES: Record<string, number> = {
  listing_delayed: 1, retracted: 2, trading_halted: 3, insufficient_baseline_data: 4, insufficient_settlement_data: 5,
  one_sided_pool: 6, no_winners: 7, empty_pool: 8,
};

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Set ${name}`);
  return v;
}

async function main() {
  const ids = process.argv.slice(2);
  if (!ids.length) throw new Error('Pass one or more Firstprint market ids');

  const keyPath = env('ORACLE_KEYPAIR').replace(/^~/, homedir());
  const oracle = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, 'utf8'))));
  const connection = new Connection(env('RPC_URL'), 'confirmed');
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(oracle), { commitment: 'confirmed' });
  const program = new anchor.Program(idl as anchor.Idl, provider);
  const mint = new PublicKey(env('USDC_MINT'));
  const treasuryToken = getAssociatedTokenAddressSync(mint, new PublicKey(env('TREASURY')), true);

  for (const id of ids) {
    const res = await fetch(`${env('FIRSTPRINT_API')}/api/markets/${encodeURIComponent(id)}/settlement`);
    if (!res.ok) {
      console.log(`${id}: not settled yet (${res.status})`);
      continue;
    }
    const { result, dataHash } = (await res.json()) as {
      dataHash: string;
      result: { winningBucket: string | null; returnPct: number | null; voidReason: string | null };
    };
    const chainId = createHash('sha256').update(id).digest().subarray(0, 16);
    const market = PublicKey.findProgramAddressSync([Buffer.from('market'), chainId], program.programId)[0];
    const vault = PublicKey.findProgramAddressSync([Buffer.from('vault'), market.toBuffer()], program.programId)[0];

    // The program voids automatically when nobody picked the winner; other voids are explicit.
    if (result.voidReason && !['no_winners', 'one_sided_pool', 'empty_pool'].includes(result.voidReason)) {
      const sig = await program.methods.voidMarket(VOID_CODES[result.voidReason] ?? 0).accountsPartial({ authority: oracle.publicKey, market }).rpc();
      console.log(`${id}: voided (${result.voidReason}) ${sig}`);
      continue;
    }
    const bucket = BUCKET_INDEX[result.winningBucket ?? 'flat'];
    const returnBps = Math.round((result.returnPct ?? 0) * 10_000);
    const sig = await program.methods
      .settle(bucket, returnBps, [...Buffer.from(dataHash, 'hex')])
      .accountsPartial({ oracle: oracle.publicKey, market, vault, treasuryToken, mint, tokenProgram: TOKEN_PROGRAM_ID })
      .rpc();
    console.log(`${id}: settled bucket ${bucket} (${returnBps} bps) ${sig}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
