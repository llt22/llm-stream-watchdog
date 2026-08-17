import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createEventStore } from '../src/event-store.js';

function event(name, fields = {}) {
  return { time: new Date().toISOString(), level: 'info', event: name, requestId: 'a4e5f230-2f2d-4c4d-8a31-c6d561961552', ...fields };
}

test('persists only whitelisted anonymous event fields and restores history', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'events.jsonl');
  const store = createEventStore({ filePath, retentionDays: 30 });
  store.record(event('upstream_attempt_started', {
    attempt: 1,
    method: 'POST',
    path: '/v1/chat/completions',
    prompt: 'must never persist',
    apiKey: 'must-never-persist',
  }));
  store.record({
    time: new Date().toISOString(),
    event: 'diagnostic',
    requestId: 'secret-client-controlled-value',
    path: '/private/customer/path',
    reason: 'secret error details',
  });
  store.record(event('upstream_retry', { attempt: 1, reason: 'first byte timeout' }));
  store.record(event('upstream_attempt_started', { attempt: 2 }));
  store.record(event('upstream_first_byte', { attempt: 2, latencyMs: 50000, status: 200 }));
  store.record(event('request_complete', { attempt: 2, durationMs: 55000 }));

  const persisted = fs.readFileSync(filePath, 'utf8');
  assert.doesNotMatch(persisted, /must never persist|must-never-persist|secret-client-controlled-value|private\/customer|secret error details|prompt|apiKey/);

  const restored = createEventStore({ filePath, retentionDays: 30 });
  const summary = restored.summary(30);
  assert.equal(summary.totals.requests, 1);
  assert.equal(summary.totals.completed, 1);
  assert.equal(summary.totals.retries, 1);
  assert.equal(summary.totals.recoveredAfterRetry, 1);
  assert.equal(summary.totals.firstByteTimeouts, 1);
  assert.equal(summary.latency.firstByteP50Ms, 50000);
  assert.equal(summary.recentAnomalies[0].event, 'upstream_retry');
});

test('counts client cancellation without classifying it as an anomaly', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = createEventStore({ filePath: path.join(directory, 'events.jsonl'), retentionDays: 30 });
  store.record(event('upstream_attempt_started', { attempt: 1, path: '/v1/chat/completions' }));
  store.record(event('downstream_cancelled', { attempt: 1, durationMs: 250 }));

  const summary = store.summary(30);
  assert.equal(summary.totals.cancelled, 1);
  assert.equal(summary.recentAnomalies.length, 0);
  assert.equal(summary.daily[0].anomalies, 0);
});

test('drops expired and malformed history during startup compaction', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'events.jsonl');
  const expired = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(filePath, [
    JSON.stringify({ time: expired, event: 'upstream_retry', requestId: 'old' }),
    'not-json',
    JSON.stringify(event('request_complete', { durationMs: 100 })),
  ].join('\n') + '\n');

  const store = createEventStore({ filePath, retentionDays: 30 });
  assert.equal(store.size(), 1);
  assert.doesNotMatch(fs.readFileSync(filePath, 'utf8'), /not-json|"old"/);
});
