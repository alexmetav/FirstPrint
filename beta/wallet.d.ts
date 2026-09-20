export interface SolanaMessageWallet {
  readonly publicKey: { toBase58(): string };
  signMessage(message: Uint8Array, encoding?: string): Promise<Uint8Array | { signature: Uint8Array }>;
}

export function messageSigningWallet(provider: unknown): SolanaMessageWallet;
