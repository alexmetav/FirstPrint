import test from 'node:test';
import assert from 'node:assert/strict';
import { messageSigningWallet } from '../beta/wallet.js';

test('wallet beta forces message signing even when Phantom exposes signIn', async () => {
  let signedBy = '';
  const provider = {
    publicKey: { toBase58: () => '11111111111111111111111111111111' },
    signIn: () => { throw new Error('incompatible SIWS path used'); },
    async signMessage() {
      signedBy = 'signMessage';
      return { signature: new Uint8Array(64) };
    },
  };

  const wallet = messageSigningWallet(provider);
  assert.equal('signIn' in wallet, false);
  assert.equal(wallet.publicKey, provider.publicKey);
  await wallet.signMessage(new Uint8Array([1]));
  assert.equal(signedBy, 'signMessage');
});

test('wallet beta rejects providers that cannot sign messages', () => {
  assert.throws(() => messageSigningWallet({ publicKey: {} }), /cannot sign/i);
});
