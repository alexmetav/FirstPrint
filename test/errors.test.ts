import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db/db.ts';
import { systemClock } from '../src/clock.ts';
import { FirstprintService } from '../src/services/firstprint.ts';
import { createApiServer } from '../src/api/server.ts';
import { ErrorLog, classifyLogLine } from '../src/services/errorLog.ts';

test('error log: repeats of one problem are one row with a count; fixed rows leave the open list', () => {
  let now = 1_000_000;
  const log = new ErrorLog(openDb(':memory:'), () => now);
  log.record({ source: 'server', code: 'server_error', message: 'boom on user 1234', where: 'POST /api/x' });
  now += 2000;
  log.record({ source: 'server', code: 'server_error', message: 'boom on user 5678', where: 'POST /api/x' });
  log.record({ source: 'background', code: 'chain', message: 'auto-claim failed' });
  const open = log.list();
  assert.equal(open.length, 2);
  const boom = open.find((e) => e.code === 'server_error')!;
  assert.equal(boom.count, 2, 'numbers in the message do not split the row');
  assert.equal(boom.message, 'boom on user 5678', 'the latest message is kept');
  assert.deepEqual(log.counts(), { open: 2, today: 3 });

  assert.equal(log.resolve(boom.id), true);
  assert.equal(log.list().length, 1);
  assert.equal(log.list(false).length, 1);
  // The same problem again after a fix opens a new row.
  log.record({ source: 'server', code: 'server_error', message: 'boom on user 1', where: 'POST /api/x' });
  assert.equal(log.list().length, 2);
  assert.equal(log.resolveAll(), 2);
  assert.equal(log.clearResolved(), 3);
  assert.equal(log.list(false).length, 0);
});

test('error log: background log lines are sorted into kinds; ordinary lines are ignored', () => {
  assert.equal(classifyLogLine('auto-claim for u1 failed: blockhash not found'), 'chain');
  assert.equal(classifyLogLine('backup: upload failed: HTTP 500'), 'backup');
  assert.equal(classifyLogLine('telegram: send failed (403)'), 'telegram');
  assert.equal(classifyLogLine('banner post failed, sending text only: fetch failed'), 'telegram');
  assert.equal(classifyLogLine('manual market published peak-m-1'), null);
  assert.equal(classifyLogLine('500 GET /api/markets: Error: x'), null, 'request errors are recorded with the request');
});

test('HTTP: a crashing request, a 5xx and an app crash land in Admin → Errors', async () => {
  const service = new FirstprintService(openDb(':memory:'), systemClock, []);
  service.errors = new ErrorLog(service.db);
  // Make one endpoint crash.
  service.listMarketsPage = () => {
    throw new Error('database is locked');
  };
  const server = createApiServer({ service, adminKey: 'admin-key-for-tests-123456', secureCookies: false, webDir: new URL('../web', import.meta.url).pathname });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const admin = { 'content-type': 'application/json', 'x-admin-key': 'admin-key-for-tests-123456' };
  try {
    assert.equal((await fetch(`${base}/api/markets`)).status, 500);
    const r = await fetch(`${base}/api/client-error`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'app_crash', message: 'x is undefined', where: '/app/#/earn', detail: 'at render' }),
    });
    assert.equal(r.status, 200);

    const list = await (await fetch(`${base}/api/admin/errors`, { headers: admin })).json();
    const codes = list.errors.map((e: { code: string; source: string }) => `${e.source}:${e.code}`).sort();
    assert.deepEqual(codes, ['app:app_crash', 'server:server_error']);
    const crash = list.errors.find((e: { code: string }) => e.code === 'server_error');
    assert.equal(crash.message, 'database is locked');
    assert.equal(crash.where, 'GET /api/markets');
    assert.equal(list.counts.open, 2);

    assert.equal((await fetch(`${base}/api/admin/errors`)).status, 403, 'admins only');
    await fetch(`${base}/api/admin/errors/${crash.id}/resolve`, { method: 'POST', headers: admin, body: '{}' });
    const after = await (await fetch(`${base}/api/admin/errors`, { headers: admin })).json();
    assert.equal(after.counts.open, 1);
  } finally {
    server.close();
  }
});
