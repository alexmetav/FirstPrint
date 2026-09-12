import * as anchor from '@coral-xyz/anchor';
import { BN, Program } from '@coral-xyz/anchor';
import { createMint, getAccount, getOrCreateAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { createHash } from 'crypto';
import { expect } from 'chai';
import type { FirstprintPools } from '../target/types/firstprint_pools';

const USDC = 1_000_000; // 6 decimals
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('firstprint-pools', () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.FirstprintPools as Program<FirstprintPools>;
  const admin = provider.wallet as anchor.Wallet;
  const conn = provider.connection;

  const oracle = Keypair.generate();
  const treasury = Keypair.generate();
  const alice = Keypair.generate();
  const bob = Keypair.generate();
  let mint: PublicKey;
  let aliceAta: PublicKey;
  let bobAta: PublicKey;
  let treasuryAta: PublicKey;

  const pda = (...seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, program.programId)[0];
  const marketId = (s: string) => createHash('sha256').update(s).digest().subarray(0, 16);
  const chainNow = async () => (await conn.getBlockTime(await conn.getSlot()))!;

  async function openMarket(name: string, closeIn: number, settleIn: number) {
    const id = marketId(name);
    const now = await chainNow();
    await program.methods
      .createMarket([...id], new BN(now), new BN(now + closeIn), new BN(now + settleIn), new BN(1_000 * USDC), new BN(500 * USDC))
      .accountsPartial({ admin: admin.publicKey, mint, tokenProgram: TOKEN_PROGRAM_ID })
      .rpc();
    const market = pda(Buffer.from('market'), id);
    return { market, vault: pda(Buffer.from('vault'), market.toBuffer()) };
  }

  async function predict(user: Keypair, ata: PublicKey, m: { market: PublicKey; vault: PublicKey }, bucket: number, amount: number) {
    return program.methods
      .placePrediction(bucket, new BN(amount))
      .accountsPartial({ market: m.market, vault: m.vault, mint, userToken: ata, user: user.publicKey, tokenProgram: TOKEN_PROGRAM_ID })
      .signers([user])
      .rpc();
  }

  async function claim(user: Keypair, ata: PublicKey, m: { market: PublicKey; vault: PublicKey }) {
    return program.methods
      .claim()
      .accountsPartial({ market: m.market, vault: m.vault, mint, ownerToken: ata, owner: user.publicKey, tokenProgram: TOKEN_PROGRAM_ID })
      .signers([user])
      .rpc();
  }

  before(async () => {
    for (const kp of [oracle, alice, bob]) {
      await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL), 'confirmed');
    }
    mint = await createMint(conn, admin.payer, admin.publicKey, null, 6);
    aliceAta = (await getOrCreateAssociatedTokenAccount(conn, admin.payer, mint, alice.publicKey)).address;
    bobAta = (await getOrCreateAssociatedTokenAccount(conn, admin.payer, mint, bob.publicKey)).address;
    treasuryAta = (await getOrCreateAssociatedTokenAccount(conn, admin.payer, mint, treasury.publicKey)).address;
    await mintTo(conn, admin.payer, mint, aliceAta, admin.payer, 1_000 * USDC);
    await mintTo(conn, admin.payer, mint, bobAta, admin.payer, 1_000 * USDC);

    await program.methods.initializeConfig(oracle.publicKey, treasury.publicKey, 400, 5_000).accountsPartial({ admin: admin.publicKey }).rpc();
  });

  it('settles a market and pays the winner', async () => {
    const m = await openMarket('kora-mexc', 8, 12);
    await predict(alice, aliceAta, m, 1, 100 * USDC); // Down
    await predict(bob, bobAta, m, 3, 300 * USDC); // Up

    try {
      await predict(bob, bobAta, m, 3, 300 * USDC);
      expect.fail('per-user cap should reject');
    } catch (e) {
      expect(String(e)).to.include('UserCapExceeded');
    }

    const state = await program.account.market.fetch(m.market);
    expect(state.totals.map((t: BN) => t.toNumber())).to.deep.equal([0, 100 * USDC, 0, 300 * USDC, 0]);

    await sleep(14_000);
    const hash = [...createHash('sha256').update('settlement-data').digest()];
    await program.methods
      .settle(1, -3_000, hash)
      .accountsPartial({ oracle: oracle.publicKey, market: m.market, vault: m.vault, treasuryToken: treasuryAta, mint, tokenProgram: TOKEN_PROGRAM_ID })
      .signers([oracle])
      .rpc();

    const before = Number((await getAccount(conn, aliceAta)).amount);
    await claim(alice, aliceAta, m);
    const after = Number((await getAccount(conn, aliceAta)).amount);
    expect(after - before).to.equal(384 * USDC); // pool 400 − 4% fee, sole winner
    expect(Number((await getAccount(conn, treasuryAta)).amount)).to.equal(16 * USDC);

    try {
      await claim(bob, bobAta, m);
      expect.fail('loser has nothing to claim');
    } catch (e) {
      expect(String(e)).to.include('NothingToClaim');
    }
    try {
      await claim(alice, aliceAta, m);
      expect.fail('double claim');
    } catch (e) {
      expect(String(e)).to.include('AlreadyClaimed');
    }
  });

  it('voids a market and refunds in full', async () => {
    const m = await openMarket('delayed-listing', 60, 120);
    const start = Number((await getAccount(conn, aliceAta)).amount);
    await predict(alice, aliceAta, m, 4, 50 * USDC);
    await program.methods.voidMarket(1).accountsPartial({ authority: admin.publicKey, market: m.market }).rpc();
    await claim(alice, aliceAta, m);
    expect(Number((await getAccount(conn, aliceAta)).amount)).to.equal(start);
  });

  it('rejects settlement from anyone but the oracle', async () => {
    const m = await openMarket('fake-oracle', 60, 120);
    try {
      await program.methods
        .settle(0, 0, new Array(32).fill(0))
        .accountsPartial({ oracle: bob.publicKey, market: m.market, vault: m.vault, treasuryToken: treasuryAta, mint, tokenProgram: TOKEN_PROGRAM_ID })
        .signers([bob])
        .rpc();
      expect.fail('non-oracle settle should fail');
    } catch (e) {
      expect(String(e)).to.match(/ConstraintHasOne|has one/i);
    }
  });
});
