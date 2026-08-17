import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { once } from 'node:events';
import { handleDashboardRequest } from '../src/dashboard.js';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function close(server) {
  server.close();
  await once(server, 'close');
}

test('serves the local dashboard and anonymous summary API', async (t) => {
  const store = {
    summary(days) {
      assert.equal(days, '7');
      return { generatedAt: new Date().toISOString(), days: 7, totals: { requests: 2 }, latency: {}, daily: [], recentAnomalies: [] };
    },
  };
  const config = {
    upstreamBaseUrl: new URL('https://provider.example/v1'),
    eventRetentionDays: 30,
    firstByteTimeoutMs: 45000,
    nonStreamingFirstByteTimeoutMs: 120000,
    idleTimeoutMs: 180000,
    maxAttempts: 2,
  };
  const server = http.createServer((request, response) => {
    if (!handleDashboardRequest(request, response, { store, config })) {
      response.statusCode = 404;
      response.end();
    }
  });
  const port = await listen(server);
  t.after(() => close(server));

  const page = await fetch('http://127.0.0.1:' + port + '/dashboard');
  assert.equal(page.status, 200);
  assert.ok(page.headers.get('content-type').includes('text/html'));
  assert.match(await page.text(), /LLM Stream Watchdog/);

  const api = await fetch('http://127.0.0.1:' + port + '/api/dashboard?days=7');
  const payload = await api.json();
  assert.equal(payload.totals.requests, 2);
  assert.equal(payload.runtime.upstreamConfigured, true);
  assert.equal(payload.runtime.upstream, undefined);
  assert.equal(payload.runtime.retentionDays, 30);
});
