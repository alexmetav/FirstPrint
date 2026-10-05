/**
 * TestFPT: the on-chain receipt for Firstprint points, a Token-2022 token on a Solana test
 * network with its name stored on the mint (so wallets show "TestFPT").
 *
 * The server holds the mint authority. When a player claims, the server builds a transaction
 * that creates their token account (if needed) and mints the claimed amount to it, signs it as
 * the mint authority, and hands it to the player's wallet. The player is the fee payer, so they
 * sign and pay the network fee in test SOL. The server then checks the signed transaction is
 * exactly the one it built before sending it.
 */
import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  lamports,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Base64EncodedWireTransaction,
  type Blockhash,
  type KeyPairSigner,
  type Signature,
  type Transaction,
} from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  extension,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMintInstruction,
  getMintSize,
  getMintToCheckedInstruction,
  getPostInitializeInstructionsForMintExtensions,
  getPreInitializeInstructionsForMintExtensions,
} from '@solana-program/token-2022';
import { base58Decode, base58Encode } from './base58.ts';
import { verifyEd25519 } from './siws.ts';

export const TOKEN_NAME = 'TestFPT';
export const TOKEN_SYMBOL = 'TestFPT';
export const TOKEN_METADATA_URI = 'https://www.firstprint.fun/testfpt.json';
/** Points are whole numbers, so the token has no decimals: 1 point = 1 TestFPT. */
export const TOKEN_DECIMALS = 0;

export type Cluster = 'testnet' | 'devnet';
export type ChainStatus = 'confirmed' | 'failed' | 'unknown';

/** The few chain calls Firstprint needs. RPC in production; an in-process VM in tests. */
export interface Chain {
  latestBlockhash(): Promise<{ blockhash: Blockhash; lastValidBlockHeight: bigint }>;
  blockHeight(): Promise<bigint>;
  minimumBalance(space: number): Promise<bigint>;
  balance(addr: Address): Promise<bigint>;
  send(wire: Base64EncodedWireTransaction): Promise<Signature>;
  status(sig: Signature): Promise<ChainStatus>;
  airdrop(addr: Address, amountLamports: bigint): Promise<Signature>;
}

export const rpcUrlFor = (cluster: Cluster) => `https://api.${cluster}.solana.com`;
export const explorerTx = (sig: string, cluster: Cluster) => `https://explorer.solana.com/tx/${sig}?cluster=${cluster}`;
export const explorerAddress = (addr: string, cluster: Cluster) => `https://explorer.solana.com/address/${addr}?cluster=${cluster}`;

export function rpcChain(url: string): Chain {
  const rpc = createSolanaRpc(url);
  return {
    async latestBlockhash() {
      const { value } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
      return { blockhash: value.blockhash, lastValidBlockHeight: value.lastValidBlockHeight };
    },
    blockHeight: () => rpc.getBlockHeight({ commitment: 'confirmed' }).send(),
    minimumBalance: (space) => rpc.getMinimumBalanceForRentExemption(BigInt(space)).send(),
    async balance(addr) {
      return (await rpc.getBalance(addr, { commitment: 'confirmed' }).send()).value;
    },
    send: (wire) => rpc.sendTransaction(wire, { encoding: 'base64', preflightCommitment: 'confirmed' }).send(),
    async status(sig) {
      const { value } = await rpc.getSignatureStatuses([sig], { searchTransactionHistory: true }).send();
      const s = value[0];
      if (!s) return 'unknown';
      if (s.err) return 'failed';
      return s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized' ? 'confirmed' : 'unknown';
    },
    airdrop: (addr, amount) => rpc.requestAirdrop(addr, lamports(amount)).send(),
  };
}

/**
 * Reads a mint authority secret: a solana-keygen JSON array of 64 bytes, base58 of 64 bytes,
 * or a 32-byte seed as hex (what Firstprint generates and stores).
 */
export async function signerFromSecret(secret: string): Promise<KeyPairSigner> {
  const s = secret.trim();
  if (s.startsWith('[')) return createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(s) as number[]));
  if (/^[0-9a-f]{64}$/i.test(s)) return createKeyPairSignerFromPrivateKeyBytes(Uint8Array.from(Buffer.from(s, 'hex')));
  const bytes = base58Decode(s);
  if (bytes.length === 64) return createKeyPairSignerFromBytes(bytes);
  throw new Error('The TestFPT authority key must be a 64-byte keypair (JSON array or base58) or a 32-byte hex seed.');
}

export async function sendAndConfirm(chain: Chain, wire: Base64EncodedWireTransaction, timeoutMs = 45_000): Promise<Signature> {
  const sig = await chain.send(wire);
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const st = await chain.status(sig);
    if (st === 'confirmed') return sig;
    if (st === 'failed') throw new Error(`Transaction ${sig} failed on chain.`);
    await new Promise((r) => setTimeout(r, 1_500));
  }
  throw new Error(`Transaction ${sig} was not confirmed in time.`);
}

/** Creates the TestFPT mint (with its name and symbol on the mint). The authority pays. */
export async function createTestFptMint(chain: Chain, authority: KeyPairSigner): Promise<Address> {
  const mint = await generateKeyPairSigner();
  const metadata = extension('TokenMetadata', {
    updateAuthority: authority.address,
    mint: mint.address,
    name: TOKEN_NAME,
    symbol: TOKEN_SYMBOL,
    uri: TOKEN_METADATA_URI,
    additionalMetadata: new Map(),
  });
  const pointer = extension('MetadataPointer', { authority: authority.address, metadataAddress: mint.address });
  // The account starts with room for the pointer; initialising the metadata grows it, so fund the final size.
  const rent = await chain.minimumBalance(getMintSize([pointer, metadata]));
  const { blockhash, lastValidBlockHeight } = await chain.latestBlockhash();
  const tx = await pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(authority, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
    (m) =>
      appendTransactionMessageInstructions(
        [
          getCreateAccountInstruction({ payer: authority, newAccount: mint, lamports: rent, space: getMintSize([pointer]), programAddress: TOKEN_2022_PROGRAM_ADDRESS }),
          ...getPreInitializeInstructionsForMintExtensions(mint.address, [pointer]),
          getInitializeMintInstruction({ mint: mint.address, decimals: TOKEN_DECIMALS, mintAuthority: authority.address }),
          ...getPostInitializeInstructionsForMintExtensions(mint.address, authority, [metadata]),
        ],
        m,
      ),
    (m) => signTransactionMessageWithSigners(m),
  );
  await sendAndConfirm(chain, getBase64EncodedWireTransaction(tx));
  return mint.address;
}

export interface BuiltClaim {
  /**
   * The transaction to give to the wallet. It carries no signature from the mint authority: the
   * server adds that only after checking the player's signature (checkSignedClaim), so nobody can
   * broadcast a mint the server has not approved.
   */
  transaction: Base64EncodedWireTransaction;
  /** The exact message the wallet must sign, to compare with what comes back. */
  message: string;
  lastValidBlockHeight: bigint;
}

/** A transaction that mints `amount` TestFPT to `owner`'s token account, with `owner` paying the fee. */
export async function buildClaimTransaction(chain: Chain, authority: KeyPairSigner, mint: Address, owner: Address, amount: bigint): Promise<BuiltClaim> {
  const [ata] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
  const payer = createNoopSigner(owner);
  const mintAuthority = createNoopSigner(authority.address);
  const { blockhash, lastValidBlockHeight } = await chain.latestBlockhash();
  const tx = await pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(owner, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
    (m) =>
      appendTransactionMessageInstructions(
        [
          getCreateAssociatedTokenIdempotentInstruction({ payer, ata, owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }),
          getMintToCheckedInstruction({ mint, token: ata, mintAuthority, amount, decimals: TOKEN_DECIMALS }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS }),
        ],
        m,
      ),
    (m) => partiallySignTransactionMessageWithSigners(m),
  );
  return {
    transaction: getBase64EncodedWireTransaction(tx),
    message: Buffer.from(tx.messageBytes).toString('base64'),
    lastValidBlockHeight,
  };
}

/**
 * Checks a transaction the wallet signed: it must be exactly the message the server built, with a
 * valid signature from the player. Only then does the mint authority sign it. Returns it ready to send.
 */
export async function checkSignedClaim(signedBase64: string, expectedMessage: string, owner: string, authority: KeyPairSigner): Promise<Base64EncodedWireTransaction> {
  let tx: Transaction;
  try {
    tx = getTransactionDecoder().decode(getBase64Encoder().encode(signedBase64));
  } catch {
    throw new Error('The wallet returned a transaction that could not be read.');
  }
  const message = Uint8Array.from(tx.messageBytes);
  if (Buffer.from(message).toString('base64') !== expectedMessage) throw new Error('The signed transaction is not the one Firstprint prepared.');
  const sig = tx.signatures[address(owner)];
  if (!sig || !verifyEd25519(owner, message, Uint8Array.from(sig))) throw new Error('The transaction is missing a valid signature from your wallet.');
  const [authoritySig] = await authority.signMessages([{ content: message, signatures: {} }]);
  return getBase64EncodedWireTransaction({ ...tx, signatures: { ...tx.signatures, ...authoritySig } } as Transaction);
}

/** The first signature of a transaction is its id on chain. */
export function transactionId(wire: string): string {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
  return base58Encode(Uint8Array.from(Object.values(tx.signatures)[0] ?? new Uint8Array(64)));
}

/** Makes a new mint authority and returns its secret as a hex seed (stored by Firstprint). */
export async function newAuthoritySecret(): Promise<string> {
  const { randomBytes } = await import('node:crypto');
  return randomBytes(32).toString('hex');
}

export interface ServerMint {
  transaction: Base64EncodedWireTransaction;
  signature: string;
  lastValidBlockHeight: bigint;
}

/**
 * A mint the server signs and pays for on its own: `amount` TestFPT to `owner`, creating their
 * token account if needed. Minting needs no signature from the owner, so this works for every
 * player's wallet, and the player never needs test SOL.
 */
export async function buildServerMint(chain: Chain, authority: KeyPairSigner, mint: Address, owner: Address, amount: bigint): Promise<ServerMint> {
  const [ata] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
  const { blockhash, lastValidBlockHeight } = await chain.latestBlockhash();
  const tx = await pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(authority, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
    (m) =>
      appendTransactionMessageInstructions(
        [
          getCreateAssociatedTokenIdempotentInstruction({ payer: authority, ata, owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }),
          getMintToCheckedInstruction({ mint, token: ata, mintAuthority: authority, amount, decimals: TOKEN_DECIMALS }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS }),
        ],
        m,
      ),
    (m) => signTransactionMessageWithSigners(m),
  );
  const wire = getBase64EncodedWireTransaction(tx);
  return { transaction: wire, signature: transactionId(wire), lastValidBlockHeight };
}
