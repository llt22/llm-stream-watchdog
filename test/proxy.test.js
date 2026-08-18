import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { once } from 'node:events';
import { createProxyServer, loadConfig } from '../src/proxy.js';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function close(server) {
  if (!server.listening) return;
  server.close();
  await once(server, 'close');
}

function config(upstreamPort, overrides = {}) {
  return {
    host: '127.0.0.1',
    port: 0,
    upstreamBaseUrl: new URL('http://127.0.0.1:' + upstreamPort + '/v1'),
    firstByteTimeoutMs: 80,
    nonStreamingFirstByteTimeoutMs: 80,
    idleTimeoutMs: 80,
    maxAttempts: 2,
    maxRequestBodyBytes: 64 * 1024 * 1024,
    ...overrides,
  };
}

test('requires an explicit upstream and uses protocol-aware timeout defaults', () => {
  assert.throws(() => loadConfig({}), /UPSTREAM_BASE_URL is required/);
  const loaded = loadConfig({ UPSTREAM_BASE_URL: 'https://provider.example/v1' });
  assert.equal(loaded.firstByteTimeoutMs, 45000);
  assert.equal(loaded.nonStreamingFirstByteTimeoutMs, 120000);
  assert.equal(loaded.maxRequestBodyBytes, 64 * 1024 * 1024);
  assert.equal(loaded.eventRetentionDays, 30);
  assert.equal(loadConfig({ UPSTREAM_BASE_URL: 'https://provider.example/v1', EVENT_RETENTION_DAYS: '365' }).eventRetentionDays, 30);
});

test('forwards models requests and preserves the v1 path', async (t) => {
  const upstream = http.createServer((request, response) => {
    assert.equal(request.url, '/v1/models?available=true');
    assert.equal(request.headers.authorization, 'Bearer client-key');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
  });
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer(config(upstreamPort), { logger: () => {} });
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch('http://127.0.0.1:' + proxyPort + '/v1/models?available=true', {
    headers: { authorization: 'Bearer client-key' },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: [{ id: 'test-model' }] });
});

test('forwards chat completions while replacing client-controlled request IDs', async (t) => {
  let upstreamRequestId;
  const upstream = http.createServer(async (request, response) => {
    assert.equal(request.method, 'POST');
    upstreamRequestId = request.headers['x-client-request-id'];
    assert.equal(request.url, '/v1/chat/completions');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString('utf8')), {
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
    });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi' } }] }));
  });
  const upstreamPort = await listen(upstream);
  const logs = [];
  const proxy = createProxyServer(config(upstreamPort), { logger: (line) => logs.push(JSON.parse(line)) });
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch('http://127.0.0.1:' + proxyPort + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-request-id': 'secret-client-controlled-value' },
    body: JSON.stringify({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
    }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    choices: [{ message: { role: 'assistant', content: 'hi' } }],
  });
  assert.match(upstreamRequestId, /^[0-9a-f-]{36}$/);
  assert.notEqual(upstreamRequestId, 'secret-client-controlled-value');
  assert.ok(logs.every((entry) => entry.requestId !== 'secret-client-controlled-value'));
});

test('retries when the first attempt produces no response body bytes', async (t) => {
  let attempts = 0;
  const upstream = http.createServer((request, response) => {
    attempts += 1;
    response.setHeader('content-type', 'text/event-stream');
    response.flushHeaders();
    if (attempts === 1) return;
    response.end('data: {"type":"response.completed"}\n\ndata: [DONE]\n\n');
  });
  const upstreamPort = await listen(upstream);
  const logs = [];
  const proxy = createProxyServer(config(upstreamPort), { logger: (line) => logs.push(JSON.parse(line)) });
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch('http://127.0.0.1:' + proxyPort + '/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'test', stream: true, input: 'hello' }),
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /response.completed/);
  assert.equal(attempts, 2);
  assert.ok(logs.some((entry) => entry.event === 'upstream_retry'));
});

test('terminates a partial stream that becomes idle without replaying it', async (t) => {
  let attempts = 0;
  const upstream = http.createServer((request, response) => {
    attempts += 1;
    response.setHeader('content-type', 'text/event-stream');
    response.flushHeaders();
    response.write('data: {"type":"response.output_text.delta","delta":"hello"}\n\n');
  });
  const upstreamPort = await listen(upstream);
  const logs = [];
  const proxy = createProxyServer(config(upstreamPort), { logger: (line) => logs.push(JSON.parse(line)) });
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const result = await new Promise((resolve, reject) => {
    const request = http.get('http://127.0.0.1:' + proxyPort + '/v1/responses', (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('aborted', () => resolve({ body, aborted: true }));
      response.on('end', () => resolve({ body, aborted: false }));
      response.on('error', (error) => {
        if (error.code === 'ECONNRESET') resolve({ body, aborted: true });
        else reject(error);
      });
    });
    request.on('error', reject);
  });

  assert.match(result.body, /hello/);
  assert.equal(result.aborted, true);
  assert.equal(attempts, 1);
  assert.ok(logs.some((entry) => entry.event === 'upstream_stream_stalled'));
});

test('classifies SSE EOF without a completion marker as an interruption', async (t) => {
  const upstream = http.createServer((request, response) => {
    response.setHeader('content-type', 'text/event-stream');
    response.write('data: {"type":"response.output_text.delta","delta":"partial"}\n\n');
    response.end();
  });
  const upstreamPort = await listen(upstream);
  const logs = [];
  const proxy = createProxyServer(config(upstreamPort), { logger: (line) => logs.push(JSON.parse(line)) });
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  await new Promise((resolve) => {
    const request = http.request({
      host: '127.0.0.1', port: proxyPort, path: '/v1/responses', method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, (response) => {
      response.resume();
      response.on('aborted', resolve);
      response.on('end', resolve);
      response.on('error', resolve);
    });
    request.on('error', resolve);
    request.end(JSON.stringify({ model: 'test', stream: true, input: 'hello' }));
  });

  assert.ok(logs.some((entry) => entry.event === 'stream_error_after_commit' && entry.reason === 'stream ended before completion'));
  assert.ok(!logs.some((entry) => entry.event === 'request_complete'));
});

test('uses only client-supplied authentication and ignores retired key config', async (t) => {
  const retiredSecret = 'retired-watchdog-secret';
  const upstream = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, 'Bearer client-selected-key');
    assert.equal(request.headers['x-api-key'], 'client-selected-secondary-header');
    response.end('ok');
  });
  const upstreamPort = await listen(upstream);
  const logs = [];
  const proxy = createProxyServer(config(upstreamPort, { upstreamApiKey: retiredSecret }), {
    logger: (line) => logs.push(line),
  });
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch('http://127.0.0.1:' + proxyPort + '/v1/models', {
    headers: {
      authorization: 'Bearer client-selected-key',
      'x-api-key': 'client-selected-secondary-header',
    },
  });
  assert.equal(await response.text(), 'ok');
  assert.ok(logs.every((line) => !line.includes(retiredSecret) && !line.includes('client-selected-key')));
  assert.equal(loadConfig({ UPSTREAM_BASE_URL: 'https://provider.example/v1', UPSTREAM_API_KEY: retiredSecret }).upstreamApiKey, undefined);
});

test('rotates configured keys for the model group after checking usage', async (t) => {
  const modelKeys = [];
  const usageKeys = [];
  const upstream = http.createServer((request, response) => {
    if (request.url.startsWith('/v1/usage')) {
      usageKeys.push(request.headers.authorization);
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify({ quota: { remaining: 10 } }));
    }
    modelKeys.push(request.headers.authorization);
    response.end('ok');
  });
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer(config(upstreamPort, {
    openaiApiKeys: ['openai-one', 'openai-two'],
    claudeApiKeys: [],
  }), { logger: () => {} });
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  for (let index = 0; index < 2; index += 1) {
    const response = await fetch('http://127.0.0.1:' + proxyPort + '/v1/models');
    assert.equal(await response.text(), 'ok');
  }

  assert.deepEqual(modelKeys, ['Bearer openai-one', 'Bearer openai-two']);
  assert.deepEqual(usageKeys.sort(), ['Bearer openai-one', 'Bearer openai-two']);
});

test('reuses the same key when retrying a 503 upstream', async (t) => {
  const authSeq = [];
  let modelHits = 0;
  const upstream = http.createServer((request, response) => {
    if (request.url.startsWith('/v1/usage')) {
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify({ quota: { remaining: 10 } }));
    }
    authSeq.push(request.headers.authorization);
    modelHits += 1;
    if (modelHits < 2) { response.statusCode = 503; return response.end('unavailable'); }
    response.end('ok');
  });
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer(config(upstreamPort, {
    openaiApiKeys: ['openai-one', 'openai-two'],
    claudeApiKeys: [],
  }), { logger: () => {} });
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch('http://127.0.0.1:' + proxyPort + '/v1/models');
  assert.equal(await response.text(), 'ok');
  assert.deepEqual(authSeq, ['Bearer openai-one', 'Bearer openai-one']);
});

test('rotates to the next key when retrying a 429 upstream', async (t) => {
  const authSeq = [];
  let modelHits = 0;
  const upstream = http.createServer((request, response) => {
    if (request.url.startsWith('/v1/usage')) {
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify({ quota: { remaining: 10 } }));
    }
    authSeq.push(request.headers.authorization);
    modelHits += 1;
    if (modelHits < 2) { response.statusCode = 429; return response.end('rate limited'); }
    response.end('ok');
  });
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer(config(upstreamPort, {
    openaiApiKeys: ['openai-one', 'openai-two'],
    claudeApiKeys: [],
  }), { logger: () => {} });
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch('http://127.0.0.1:' + proxyPort + '/v1/models');
  assert.equal(await response.text(), 'ok');
  assert.deepEqual(authSeq, ['Bearer openai-one', 'Bearer openai-two']);
});

test('merges model lists from both pools with distinct keys', async (t) => {
  const upstream = http.createServer((request, response) => {
    if (request.url.startsWith('/v1/usage')) {
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify({ quota: { remaining: 10 } }));
    }
    const auth = request.headers.authorization;
    response.setHeader('content-type', 'application/json');
    if (auth === 'Bearer claude-key') {
      return response.end(JSON.stringify({ data: [{ id: 'claude-sonnet-5' }, { id: 'shared-model' }] }));
    }
    return response.end(JSON.stringify({ data: [{ id: 'gpt-5.4' }, { id: 'shared-model' }] }));
  });
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer(config(upstreamPort, {
    openaiApiKeys: ['openai-key'],
    claudeApiKeys: ['claude-key'],
  }), { logger: () => {} });
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch('http://127.0.0.1:' + proxyPort + '/v1/models');
  const body = await response.json();
  const ids = body.data.map((model) => model.id).sort();
  assert.deepEqual(ids, ['claude-sonnet-5', 'gpt-5.4', 'shared-model']);
});

test('returns available models when one pool fails to list', async (t) => {
  const upstream = http.createServer((request, response) => {
    if (request.url.startsWith('/v1/usage')) {
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify({ quota: { remaining: 10 } }));
    }
    if (request.headers.authorization === 'Bearer claude-key') {
      response.statusCode = 503;
      return response.end('unavailable');
    }
    response.setHeader('content-type', 'application/json');
    return response.end(JSON.stringify({ data: [{ id: 'gpt-5.4' }] }));
  });
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer(config(upstreamPort, {
    openaiApiKeys: ['openai-key'],
    claudeApiKeys: ['claude-key'],
  }), { logger: () => {} });
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch('http://127.0.0.1:' + proxyPort + '/v1/models');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.data.map((model) => model.id), ['gpt-5.4']);
});

test('does not aggregate models when only one pool is configured', async (t) => {
  let modelCalls = 0;
  const upstream = http.createServer((request, response) => {
    if (request.url.startsWith('/v1/usage')) {
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify({ quota: { remaining: 10 } }));
    }
    modelCalls += 1;
    response.setHeader('content-type', 'application/json');
    return response.end(JSON.stringify({ data: [{ id: 'gpt-5.4' }] }));
  });
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer(config(upstreamPort, {
    openaiApiKeys: ['openai-key'],
    claudeApiKeys: [],
  }), { logger: () => {} });
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch('http://127.0.0.1:' + proxyPort + '/v1/models');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.data.map((model) => model.id), ['gpt-5.4']);
  assert.equal(modelCalls, 1);
});

test('replaces client credentials with the pool key and strips other auth headers', async (t) => {
  const received = [];
  const upstream = http.createServer((request, response) => {
    if (request.url.startsWith('/v1/usage')) {
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify({ quota: { remaining: 10 } }));
    }
    received.push({
      authorization: request.headers.authorization,
      xApiKey: request.headers['x-api-key'],
      apiKey: request.headers['api-key'],
    });
    response.end('ok');
  });
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer(config(upstreamPort, {
    openaiApiKeys: ['pool-key'],
    claudeApiKeys: [],
  }), { logger: () => {} });
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch('http://127.0.0.1:' + proxyPort + '/v1/models', {
    headers: { authorization: 'Bearer client-key', 'x-api-key': 'client-x', 'api-key': 'client-api' },
  });
  assert.equal(await response.text(), 'ok');
  assert.deepEqual(received, [{ authorization: 'Bearer pool-key', xApiKey: undefined, apiKey: undefined }]);
});


test('times out and retries before upstream sends response headers', async (t) => {
  let attempts = 0;
  const upstream = http.createServer((request, response) => {
    attempts += 1;
    if (attempts === 1) return;
    response.end('recovered');
  });
  const upstreamPort = await listen(upstream);
  const logs = [];
  const proxy = createProxyServer(config(upstreamPort), { logger: (line) => logs.push(JSON.parse(line)) });
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch('http://127.0.0.1:' + proxyPort + '/v1/models');
  assert.equal(await response.text(), 'recovered');
  assert.equal(attempts, 2);
  assert.ok(logs.some((entry) => entry.event === 'upstream_retry' && entry.reason === 'first byte timeout'));
});

test('retries retryable status without exposing the first response', async (t) => {
  let attempts = 0;
  const upstream = http.createServer((request, response) => {
    attempts += 1;
    if (attempts === 1) {
      response.statusCode = 503;
      return response.end('temporary failure');
    }
    response.end('recovered');
  });
  const upstreamPort = await listen(upstream);
  const logs = [];
  const proxy = createProxyServer(config(upstreamPort), { logger: (line) => logs.push(JSON.parse(line)) });
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch('http://127.0.0.1:' + proxyPort + '/v1/models');
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'recovered');
  assert.equal(attempts, 2);
  assert.ok(logs.some((entry) => entry.event === 'upstream_retry' && entry.reason === 'status_503'));
});

test('cancelling the downstream response aborts upstream promptly', async (t) => {
  let upstreamClosedResolve;
  const upstreamClosed = new Promise((resolve) => { upstreamClosedResolve = resolve; });
  const upstream = http.createServer((request, response) => {
    response.setHeader('content-type', 'text/event-stream');
    response.flushHeaders();
    response.write('data: hello\n\n');
    response.once('close', upstreamClosedResolve);
  });
  const upstreamPort = await listen(upstream);
  const logs = [];
  const proxy = createProxyServer(config(upstreamPort, { idleTimeoutMs: 5000 }), {
    logger: (line) => logs.push(JSON.parse(line)),
  });
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  await new Promise((resolve, reject) => {
    const request = http.get('http://127.0.0.1:' + proxyPort + '/v1/responses', (response) => {
      response.once('data', () => {
        response.destroy();
        resolve();
      });
    });
    request.on('error', reject);
  });

  await Promise.race([
    upstreamClosed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('upstream was not cancelled promptly')), 500)),
  ]);
  assert.ok(logs.some((entry) => entry.event === 'downstream_cancelled'));
});

test('does not retry a transport failure after response bytes are committed', async (t) => {
  let attempts = 0;
  const upstream = http.createServer((request, response) => {
    attempts += 1;
    response.setHeader('content-type', 'text/event-stream');
    response.flushHeaders();
    response.write('data: partial\n\n');
    setTimeout(() => response.socket.destroy(new Error('upstream reset')), 20);
  });
  const upstreamPort = await listen(upstream);
  const logs = [];
  const proxy = createProxyServer(config(upstreamPort), { logger: (line) => logs.push(JSON.parse(line)) });
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  await new Promise((resolve) => {
    const request = http.get('http://127.0.0.1:' + proxyPort + '/v1/responses', (response) => {
      response.resume();
      response.on('aborted', resolve);
      response.on('end', resolve);
      response.on('error', resolve);
    });
    request.on('error', resolve);
  });

  assert.equal(attempts, 1);
  assert.ok(logs.some((entry) => entry.event === 'stream_error_after_commit'));
  assert.ok(!logs.some((entry) => entry.event === 'upstream_retry'));
});

test('maps the exact local API root to the exact upstream API root', async (t) => {
  const upstream = http.createServer((request, response) => {
    assert.equal(request.url, '/v1?probe=true');
    response.end('root');
  });
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer(config(upstreamPort), { logger: () => {} });
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch('http://127.0.0.1:' + proxyPort + '/v1?probe=true');
  assert.equal(await response.text(), 'root');
});

test('rejects request bodies over the configured limit', async (t) => {
  let attempts = 0;
  const upstream = http.createServer(() => { attempts += 1; });
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer(config(upstreamPort, { maxRequestBodyBytes: 8 }), { logger: () => {} });
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch('http://127.0.0.1:' + proxyPort + '/v1/responses', {
    method: 'POST',
    body: '0123456789',
  });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error, 'request_body_too_large');
  assert.equal(attempts, 0);
});

test('preserves multiple set-cookie response headers', async (t) => {
  const upstream = http.createServer((request, response) => {
    response.setHeader('set-cookie', ['a=1; Path=/', 'b=2; Path=/']);
    response.end('ok');
  });
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer(config(upstreamPort), { logger: () => {} });
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch('http://127.0.0.1:' + proxyPort + '/v1/models');
  assert.deepEqual(response.headers.getSetCookie(), ['a=1; Path=/', 'b=2; Path=/']);
});

test('forwards non-stream Responses API JSON', async (t) => {
  const upstream = http.createServer((request, response) => {
    assert.equal(request.url, '/v1/responses');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ id: 'resp_test', status: 'completed' }));
  });
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer(config(upstreamPort), { logger: () => {} });
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch('http://127.0.0.1:' + proxyPort + '/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'test', input: 'hello' }),
  });
  assert.deepEqual(await response.json(), { id: 'resp_test', status: 'completed' });
});


test('allows healthy non-streaming responses beyond the streaming timeout', async (t) => {
  let attempts = 0;
  const upstream = http.createServer((request, response) => {
    attempts += 1;
    setTimeout(() => response.end(JSON.stringify({ status: 'completed' })), 70);
  });
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer(config(upstreamPort, {
    firstByteTimeoutMs: 25,
    nonStreamingFirstByteTimeoutMs: 150,
  }), { logger: () => {} });
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch('http://127.0.0.1:' + proxyPort + '/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'test', input: 'long reasoning', stream: false }),
  });
  assert.deepEqual(await response.json(), { status: 'completed' });
  assert.equal(attempts, 1);
});
