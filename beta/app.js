import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';
import { messageSigningWallet } from './wallet.js';

const cfg = window.FP_SUPABASE ?? {};
const configured = /^https:\/\/[a-z0-9]+\.supabase\.co$/.test(cfg.url ?? '') && cfg.publishableKey && !cfg.publishableKey.startsWith('__');
const supabase = configured ? createClient(cfg.url, cfg.publishableKey, { auth: { persistSession: true, autoRefreshToken: true } }) : null;
const buckets = ['crash', 'down', 'flat', 'up', 'moon'];
const labels = { crash: 'Crash', down: 'Down', flat: 'Flat', up: 'Up', moon: 'Moon' };
const $ = (s) => document.querySelector(s);
let dashboard = null;
let busy = false;

function toast(message, error = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = error ? 'show error' : 'show';
  setTimeout(() => (el.className = ''), 3500);
}

function short(address) { return address ? `${address.slice(0, 4)}…${address.slice(-4)}` : ''; }
function points(n) { return `${Number(n ?? 0).toLocaleString()} pts`; }
function remaining(ts) {
  const ms = Math.max(0, Number(ts) - Date.now());
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return ms ? `${h}h ${m}m` : 'Closed';
}
function safe(text) { return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

function walletProvider() {
  return window.phantom?.solana ?? window.solflare ?? window.backpack ?? window.solana ?? null;
}

async function connect() {
  if (!supabase) return toast('Beta configuration is not deployed yet.', true);
  const wallet = walletProvider();
  if (!wallet) return toast('Install Phantom, Solflare, or Backpack first.', true);
  busy = true;
  try {
    const connected = await wallet.connect();
    const address = (connected?.publicKey ?? wallet.publicKey)?.toString();
    if (!address) throw new Error('The wallet did not share an address.');
    const { error } = await supabase.auth.signInWithWeb3({
      chain: 'solana',
      wallet: messageSigningWallet(wallet),
      statement: 'Sign in to Firstprint practice points. No transaction or fee will be requested.',
      options: { url: `${location.origin}${location.pathname}` },
    });
    if (error) throw error;
    const { error: profileError } = await supabase.rpc('fp_bootstrap_profile', { p_wallet: address });
    if (profileError) throw profileError;
    await load();
    toast('Wallet connected. Your points are saved.');
  } catch (err) {
    toast(err.message || 'Wallet sign-in failed.', true);
  } finally { busy = false; }
}

async function load() {
  if (!supabase) return renderSetup();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return renderSignedOut();
  // Wake the trusted detector; stale persisted markets remain usable if it is asleep.
  await fetch('/api/mexc-focus').catch(() => null);
  const { data, error } = await supabase.rpc('fp_get_dashboard');
  if (error) throw error;
  dashboard = data;
  render();
}

function renderSetup() {
  $('#notice').textContent = 'The Supabase publishable key has not been configured in Vercel yet.';
  $('#wallet').disabled = true;
}

function renderSignedOut() {
  dashboard = null;
  $('#wallet').textContent = 'Connect Solana wallet';
  $('#wallet').onclick = connect;
  $('#notice').textContent = 'Connect a wallet to begin with 1,000 persistent practice points.';
  $('#account').hidden = true;
  $('#refresh').hidden = true;
  $('#history-section').hidden = true;
  $('#leaderboard-section').hidden = true;
  $('#markets').innerHTML = '<div class="empty">Connect your wallet to load markets.</div>';
}

function render() {
  const p = dashboard.profile;
  $('#wallet').textContent = short(p.walletAddress);
  $('#wallet').onclick = logout;
  $('#notice').textContent = 'Connected with Supabase Web3 Auth. All points and predictions are stored server-side.';
  $('#account').hidden = false;
  $('#account').innerHTML = `<div><span>Available balance</span><strong>${points(p.points)}</strong><small>${safe(p.username)} · ${safe(short(p.walletAddress))}</small></div><button id="claim" class="button primary" ${p.canClaimDaily ? '' : 'disabled'}>${p.canClaimDaily ? 'Claim 100 daily points' : 'Daily points claimed'}</button>`;
  $('#claim').onclick = claim;
  $('#refresh').hidden = false;
  $('#refresh').onclick = () => load().catch((e) => toast(e.message, true));
  $('#markets').innerHTML = dashboard.markets.map(marketCard).join('') || '<div class="empty">Watching MEXC for the next new USDT listing. Markets appear only after a real pair is detected.</div>';
  document.querySelectorAll('[data-predict]').forEach((button) => button.onclick = predict);
  renderHistory();
  renderLeaderboard();
}

function marketCard(m) {
  const open = m.status === 'open' && Number(m.closesAt) > Date.now();
  return `<article class="market"><div class="market-head"><div><span>${safe(m.exchange)} · ${safe(m.pair || `${m.symbol}USDT`)}</span><h3>${safe(m.symbol)} <small>${safe(m.name)}</small></h3></div><div class="clock">${open ? `Closes in ${remaining(m.closesAt)}` : safe(m.status)}</div></div><div class="pool">Opening price ${m.openPrice ? `$${Number(m.openPrice).toLocaleString(undefined, { maximumSignificantDigits: 8 })}` : 'pending'} · Pool ${points(m.pool)}</div><div class="outcomes">${buckets.map((b) => `<button data-predict data-market="${m.id}" data-bucket="${b}" ${open ? '' : 'disabled'}><b>${labels[b]}</b><span>${points(m.totals?.[b])}</span></button>`).join('')}</div><label class="stake">Stake <input id="stake-${m.id}" type="number" min="10" max="1000" step="10" value="100" ${open ? '' : 'disabled'} /></label>${m.result ? `<p class="result">Result: <b>${labels[m.result]}</b></p>` : ''}</article>`;
}

async function predict(event) {
  if (busy) return;
  const button = event.currentTarget;
  const marketId = button.dataset.market;
  const stake = Number($(`#stake-${CSS.escape(marketId)}`).value);
  if (!Number.isInteger(stake) || stake < 10 || stake > 1000) return toast('Choose 10–1,000 whole points.', true);
  busy = true;
  try {
    const { error } = await supabase.rpc('fp_place_prediction', { p_market_id: marketId, p_bucket: button.dataset.bucket, p_stake: stake, p_request_id: crypto.randomUUID() });
    if (error) throw error;
    await load();
    toast(`Prediction placed: ${labels[button.dataset.bucket]} for ${points(stake)}.`);
  } catch (err) { toast(err.message || 'Prediction failed.', true); }
  finally { busy = false; }
}

async function claim() {
  if (busy) return;
  busy = true;
  try {
    const { error } = await supabase.rpc('fp_claim_daily_points');
    if (error) throw error;
    await load();
    toast('Added 100 points.');
  } catch (err) { toast(err.message || 'Claim failed.', true); }
  finally { busy = false; }
}

function renderHistory() {
  $('#history-section').hidden = false;
  const rows = dashboard.predictions ?? [];
  $('#history').innerHTML = rows.length ? rows.map((p) => `<div class="row"><div><b>${safe(p.symbol)}</b><span>${safe(p.exchange)} · ${labels[p.bucket]}</span></div><div><b>${points(p.stake)}</b><span>${p.payout === null ? safe(p.marketStatus) : `Payout ${points(p.payout)}`}</span></div></div>`).join('') : '<div class="empty">Your predictions will appear here.</div>';
}

function renderLeaderboard() {
  $('#leaderboard-section').hidden = false;
  $('#leaderboard').innerHTML = (dashboard.leaderboard ?? []).map((r) => `<div class="row ${r.isMe ? 'me' : ''}"><div><b>#${r.rank} ${safe(r.username)}</b></div><strong>${points(r.points)}</strong></div>`).join('');
}

async function logout() {
  await supabase.auth.signOut();
  try { await walletProvider()?.disconnect?.(); } catch {}
  renderSignedOut();
  toast('Signed out.');
}

$('#wallet').onclick = connect;
if (!configured) renderSetup();
else load().catch((e) => { renderSignedOut(); toast(e.message || 'Could not load the beta.', true); });
