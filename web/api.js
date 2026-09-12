// Backend client. DemoBackend in demo.js exposes the same methods.

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function createApi(baseUrl = '') {
  async function request(path, init = {}) {
    let res;
    try {
      res = await fetch(baseUrl + path, {
        ...init,
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
      });
    } catch {
      throw new ApiError(0, 'offline', 'Can’t reach Firstprint. Check your connection and try again.');
    }
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
    signup: (body) => post('/api/auth/signup', body),
    login: (body) => post('/api/auth/login', body),
    logout: () => post('/api/auth/logout'),
    claimDaily: () => post('/api/me/claim-daily'),
    myPredictions: () => request('/api/me/predictions'),
    markets: (filter) => request(`/api/markets?filter=${filter}`),
    market: (m) => request(`/api/markets/${id(m)}`),
    quote: (m, bucket, stake) => request(`/api/markets/${id(m)}/quote?bucket=${bucket}&stake=${stake}`),
    predict: (m, bucket, stake) => post(`/api/markets/${id(m)}/predictions`, { bucket, stake }),
    chart: (m) => request(`/api/markets/${id(m)}/chart`),
    activity: (m) => request(`/api/markets/${id(m)}/activity`),
    leaderboard: () => request('/api/leaderboard'),
    walletChallenge: (address) => request(`/api/auth/wallet/challenge?address=${encodeURIComponent(address)}`),
    walletVerify: (body) => post('/api/auth/wallet/verify', body),
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
  };
}

export async function backendAvailable(baseUrl = '') {
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch {
    return false;
  }
}
