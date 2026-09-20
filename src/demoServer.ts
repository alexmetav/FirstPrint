import { createServer, type Server, type ServerResponse } from 'node:http';
import { MarketData } from './services/marketData.ts';
import { MexcFocusWorker } from './workers/mexcFocus.ts';

export interface DemoServerOptions {
  marketData?: MarketData;
  now?: () => number;
  mexcFocus?: MexcFocusWorker;
}

/**
 * Creates the public demo API. It exposes health and allowlisted market-data
 * reads plus one input-free, rate-limited trigger for the trusted MEXC worker.
 * Authentication, prediction writes, arbitrary database access, and admin
 * routes remain unreachable from the public deployment.
 */
export function createDemoServer(options: DemoServerOptions = {}): Server {
  const marketData = options.marketData ?? new MarketData();
  const now = options.now ?? Date.now;
  const mexcFocus = options.mexcFocus ?? new MexcFocusWorker({
    supabaseUrl: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  });

  return createServer(async (req, res) => {
    setSecurityHeaders(res);

    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      return send(res, 400, { error: 'bad_path', message: 'Invalid path.' });
    }

    if (req.method !== 'GET') {
      return send(res, 405, { error: 'method_not_allowed', message: 'This demo API is read-only.' });
    }

    if (url.pathname === '/api/health') {
      return send(res, 200, { ok: true, mode: 'read-only-demo', time: now() });
    }

    if (url.pathname === '/api/market-data') {
      try {
        return send(res, 200, await marketData.get(url.searchParams.get('path') ?? ''));
      } catch (err) {
        if ((err as Error).message === 'Unsupported market data request') {
          return send(res, 400, { error: 'bad_path', message: 'Unsupported market data request.' });
        }
        return send(res, 503, { error: 'data_unavailable', message: 'Market data is temporarily unavailable.' });
      }
    }

    if (url.pathname === '/api/mexc-focus') {
      try {
        return send(res, 200, await mexcFocus.run());
      } catch {
        return send(res, 503, { error: 'sync_unavailable', message: 'MEXC market sync is temporarily unavailable.' });
      }
    }

    return send(res, 404, { error: 'not_found', message: 'Unknown endpoint.' });
  });
}

function setSecurityHeaders(res: ServerResponse) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('permissions-policy', 'camera=(), geolocation=(), microphone=(), payment=(), usb=()');
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
