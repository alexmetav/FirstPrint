/**
 * Prefer the broadly supported signMessage flow. Some Phantom versions expose
 * signIn but return a SIWS domain that Supabase rejects for preview URLs.
 */
export function messageSigningWallet(provider) {
  if (!provider?.publicKey || typeof provider.signMessage !== 'function') {
    throw new Error('This wallet cannot sign the Firstprint login message.');
  }
  return {
    get publicKey() { return provider.publicKey; },
    signMessage: provider.signMessage.bind(provider),
  };
}
