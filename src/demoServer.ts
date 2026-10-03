import { createServer, type Server, type ServerResponse } from 'node:http';

export interface DemoServerOptions {
  now?: () => number;
}

/**
 * Creates the public demo API. It intentionally has no database, authentication,
 * prediction, worker, or admin dependencies: only the health check is reachable
 * from the public demo deployment.
 */
export function createDemoServer(options: DemoServerOptions = {}): Server {
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
