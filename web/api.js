// Backend client. DemoBackend in demo.js exposes the same methods.

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Free hosting puts the server to sleep when nobody visits, and the first request after that fails with a
 * gateway error until it has started (up to about a minute). Reads are retried while that happens, and the
 * page is told so it can say so instead of showing an error. Writes are never retried: they aren't safe to repeat.
 */
export const wake = { onWaking: () => {}, onAwake: () => {} };
const WAKE_RETRIES = 16;
const WAKE_WAIT_MS = 4_000;
const GATEWAY = new Set([502, 503, 504, 520, 521, 522, 523, 524]);

export function createApi(baseUrl = '') {
  async function request(path, init = {}) {
    const canRetry = !init.method || init.method === 'GET';
    let waking = false;
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(baseUrl + path, {
          ...init,
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
        });
      } catch {
        if (canRetry && attempt < WAKE_RETRIES) {
          waking = true;
          wake.onWaking();
          await new Promise((r) => setTimeout(r, WAKE_WAIT_MS));
          continue;
        }
        if (waking) wake.onAwake();
        throw new ApiError(0, 'offline', 'Can’t reach Firstprint. Check your connection and try again.');
      }
      if (GATEWAY.has(res.status) && canRetry && attempt < WAKE_RETRIES) {
        waking = true;
        wake.onWaking();
        await new Promise((r) => setTimeout(r, WAKE_WAIT_MS));
        continue;
      }
      if (waking) wake.onAwake();
      return finish(res);
    }
  }

  async function finish(res) {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error ?? 'error', data.message ?? 'Request failed.');
    return data;
  }
  const post = (path, body) => request(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
  const id = (s) => encodeURIComponent(s);

  return {
    demo: false,
    config: () => request('/api/config'),
    me: () => request('/api/me'),
    login: (body) => post('/api/auth/login', body),
    logout: () => post('/api/auth/logout'),
    claimDaily: () => post('/api/me/claim-daily'),
    myPredictions: () => request('/api/me/predictions'),
    ledger: () => request('/api/me/ledger'),
    stats: () => request('/api/me/stats'),
    markets: (filter) => request(`/api/markets?filter=${filter}`),
    market: (m) => request(`/api/markets/${id(m)}`),
    quote: (m, bucket, stake) => request(`/api/markets/${id(m)}/quote?bucket=${bucket}&stake=${stake}`),
    predict: (m, bucket, stake) => post(`/api/markets/${id(m)}/predictions`, { bucket, stake }),
    chart: (m) => request(`/api/markets/${id(m)}/chart`),
    activity: (m) => request(`/api/markets/${id(m)}/activity`),
    leaderboard: (period = 'week') => request(`/api/leaderboard?period=${encodeURIComponent(period)}`),
    odds: (m) => request(`/api/markets/${id(m)}/odds`),
    holders: (m) => request(`/api/markets/${id(m)}/holders`),
    profile: (name) => request(`/api/users/${id(name)}`),
    notifications: () => request('/api/me/notifications'),
    markNotificationsRead: () => post('/api/me/notifications/read'),
    emailStart: (email) => post('/api/auth/email/start', { email }),
    emailVerify: (email, code) => post('/api/auth/email/verify', { email, code, ref: referralCode() }),
    googleSignIn: (credential) => post('/api/auth/google', { credential, ref: referralCode() }),
    walletChallenge: (address) => request(`/api/auth/wallet/challenge?address=${encodeURIComponent(address)}`),
    walletVerify: (body) => post('/api/auth/wallet/verify', { ...body, ref: referralCode() }),
    rewards: () => request('/api/me/rewards'),
    connectX: (username) => post('/api/me/x', { username }),
    startTask: (t) => post(`/api/tasks/${id(t)}/start`),
    verifyTask: (t) => post(`/api/tasks/${id(t)}/verify`),
    startClaim: (wallet) => post('/api/me/claims', { wallet }),
    submitClaim: (c, transaction) => post(`/api/me/claims/${id(c)}/submit`, { transaction }),
    claimStatus: (c) => request(`/api/me/claims/${id(c)}`),
    linkWallet: (body) => post('/api/me/wallets', body),
    setUsername: (username) => post('/api/me/profile', { username }),
    detectedListings: () => request('/api/listings/detected'),
    /** Live updates over Server-Sent Events. Returns an unsubscribe function. */
    subscribe(onEvent, onStatus = () => {}) {
      if (typeof EventSource === 'undefined') return () => {};
      const es = new EventSource(`${baseUrl}/api/stream`);
      for (const type of ['price', 'market', 'listing']) {
        es.addEventListener(type, (e) => {
          try {
            onEvent(type, JSON.parse(e.data));
          } catch {
            /* ignore malformed events */
          }
        });
      }
      es.onopen = () => onStatus(true);
      es.onerror = () => onStatus(false);
      return () => es.close();
    },
  };
}

/** Admin client. The key is sent as a header and never stored server-side in the browser. */
export function createAdminApi(key, baseUrl = '') {
  async function request(path, init = {}) {
    let res;
    try {
      res = await fetch(baseUrl + path, { ...init, headers: { 'content-type': 'application/json', 'x-admin-key': key } });
    } catch {
      throw new ApiError(0, 'offline', 'Can’t reach the server.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error ?? 'error', data.message ?? 'Request failed.');
    return data;
  }
  const post = (path, body) => request(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
  return {
    ping: () => request('/api/admin/ping'),
    markets: () => request('/api/admin/markets'),
    createLive: (body) => post('/api/admin/live-markets', body),
    cancel: (id) => post(`/api/admin/markets/${encodeURIComponent(id)}/cancel`),
    checkExchanges: () => request('/api/admin/exchanges/check'),
    detected: () => request('/api/admin/detected?status=pending'),
    approve: (id, body) => post(`/api/admin/detected/${id}/approve`, body),
    ignore: (id) => post(`/api/admin/detected/${id}/ignore`),
    track: () => post('/api/admin/track'),
    log: () => request('/api/admin/log'),
    exchanges: () => request('/api/admin/exchanges'),
    setExchange: (id, enabled) => post(`/api/admin/exchanges/${encodeURIComponent(id)}`, { enabled }),
    createManual: (body) => post('/api/admin/manual-markets', body),
    updateManual: (id, body) => post(`/api/admin/manual-markets/${encodeURIComponent(id)}`, body),
    publish: (id) => post(`/api/admin/manual-markets/${encodeURIComponent(id)}/publish`),
    unpublish: (id) => post(`/api/admin/manual-markets/${encodeURIComponent(id)}/unpublish`),
    deleteDraft: (id) => post(`/api/admin/manual-markets/${encodeURIComponent(id)}/delete`),
    previewResult: (id, body) => post(`/api/admin/manual-markets/${encodeURIComponent(id)}/preview`, body),
    resolve: (id, body) => post(`/api/admin/manual-markets/${encodeURIComponent(id)}/resolve`, body),
    setStartPrice: (id, basePrice) => post(`/api/admin/manual-markets/${encodeURIComponent(id)}/start-price`, { basePrice }),
    token: () => request('/api/admin/token'),
    tokenStep: (step) => post(`/api/admin/token/${encodeURIComponent(step)}`),
    tasks: () => request('/api/admin/tasks'),
    createTask: (body) => post('/api/admin/tasks', body),
    updateTask: (id, body) => post(`/api/admin/tasks/${encodeURIComponent(id)}`, body),
  };
}

/** The referral code from an invite link (?ref=...), kept until sign-up. */
export function referralCode() {
  try {
    return localStorage.getItem('fp:ref') || null;
  } catch {
    return null;
  }
}

/** Remembers ?ref=CODE from the address bar, so the invite counts when this visitor signs up. */
export function captureReferral() {
  const code = new URLSearchParams(location.search).get('ref');
  if (!code || !/^[A-Za-z0-9]{6,12}$/.test(code)) return;
  try {
    localStorage.setItem('fp:ref', code.toUpperCase());
  } catch {
    /* storage blocked: the invite just won't count */
  }
}

export async function backendAvailable(baseUrl = '') {
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch {
    return false;
  }
}
