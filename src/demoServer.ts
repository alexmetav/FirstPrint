import { createServer, type Server, type ServerResponse } from 'node:http';
import { MarketData } from './services/marketData.ts';

export interface DemoServerOptions {
  marketData?: MarketData;
  now?: () => number;
}

/**
 * Creates the public demo API. It intentionally has no database, authentication,
 * prediction, worker, or admin dependencies: only health and allowlisted market
 * data reads are reachable from the public demo deployment.
 */
export function createDemoServer(options: DemoServerOptions = {}): Server {
  const marketData = options.marketData ?? new MarketData();
  const now = options.now ?? Date.now;

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
