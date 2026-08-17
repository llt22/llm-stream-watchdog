import fs from 'node:fs';
import path from 'node:path';

const ALLOWED_FIELDS = new Set([
  'time',
  'level',
  'event',
  'requestId',
  'attempt',
  'method',
  'path',
  'status',
  'latencyMs',
  'durationMs',
  'reason',
  'idleTimeoutMs',
]);

const ANOMALY_EVENTS = new Set([
  'upstream_retry',
  'upstream_failed',
  'upstream_stream_stalled',
  'stream_error_after_commit',
  'downstream_cancelled',
]);

function sanitizePath(value) {
  return ['/v1/responses', '/v1/chat/completions', '/v1/models'].includes(value) ? value : '(other)';
}

function sanitizeReason(value) {
  const known = ['first byte timeout', 'stream idle timeout', 'downstream closed', 'upstream_transport_error'];
  if (known.includes(value) || /^status_(429|502|503|504)$/.test(value)) return value;
  return 'other';
}

function sanitizeEvent(input) {
  if (!input || typeof input !== 'object' || typeof input.event !== 'string') return undefined;
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (!ALLOWED_FIELDS.has(key)) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') output[key] = value;
  }
  if (typeof output.time !== 'string' || Number.isNaN(Date.parse(output.time))) return undefined;
  if (typeof output.requestId === 'string' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(output.requestId)) delete output.requestId;
  if (typeof output.path === 'string') output.path = sanitizePath(output.path);
  if (typeof output.reason === 'string') output.reason = sanitizeReason(output.reason);
  return output;
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function dayKey(time) {
  return time.slice(0, 10);
}

function summarize(events, days) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const scoped = events.filter((event) => Date.parse(event.time) >= cutoff);
  const requests = new Map();
  const daily = new Map();
  const anomalies = [];

  for (const event of scoped) {
    if (event.requestId) {
      const request = requests.get(event.requestId) || { attempts: 0, completed: false, started: false };
      if (event.event === 'upstream_attempt_started') {
        request.attempts = Math.max(request.attempts, event.attempt || 1);
        if (event.attempt === 1) request.started = true;
      }
      if (event.event === 'upstream_first_byte' && typeof event.latencyMs === 'number') request.firstByteMs = event.latencyMs;
      if (event.event === 'request_complete') {
        request.completed = true;
        request.durationMs = event.durationMs;
      }
      requests.set(event.requestId, request);
    }
    const day = dayKey(event.time);
    const bucket = daily.get(day) || { date: day, requests: 0, retries: 0, anomalies: 0 };
    if (event.event === 'upstream_attempt_started' && event.attempt === 1) bucket.requests += 1;
    if (event.event === 'upstream_retry') bucket.retries += 1;
    if (ANOMALY_EVENTS.has(event.event)) bucket.anomalies += 1;
    daily.set(day, bucket);
    if (ANOMALY_EVENTS.has(event.event)) anomalies.push(event);
  }

  const requestValues = [...requests.values()].filter((request) => request.started);
  const firstByteValues = requestValues.map((item) => item.firstByteMs).filter(Number.isFinite);
  const durationValues = requestValues.map((item) => item.durationMs).filter(Number.isFinite);
  const retryEvents = scoped.filter((event) => event.event === 'upstream_retry');
  const completedAfterRetry = requestValues.filter((item) => item.completed && item.attempts > 1).length;

  return {
    generatedAt: new Date().toISOString(),
    days,
    totals: {
      requests: requestValues.length,
      completed: requestValues.filter((item) => item.completed).length,
      retries: retryEvents.length,
      recoveredAfterRetry: completedAfterRetry,
      firstByteTimeouts: retryEvents.filter((event) => event.reason === 'first byte timeout').length,
      streamStalls: scoped.filter((event) => event.event === 'upstream_stream_stalled').length,
      failures: scoped.filter((event) => event.event === 'upstream_failed' || event.event === 'stream_error_after_commit').length,
      cancelled: scoped.filter((event) => event.event === 'downstream_cancelled').length,
    },
    latency: {
      firstByteP50Ms: percentile(firstByteValues, 0.5),
      firstByteP95Ms: percentile(firstByteValues, 0.95),
      firstByteMaxMs: firstByteValues.length ? Math.max(...firstByteValues) : null,
      durationP50Ms: percentile(durationValues, 0.5),
      durationP95Ms: percentile(durationValues, 0.95),
      durationMaxMs: durationValues.length ? Math.max(...durationValues) : null,
    },
    daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
    recentAnomalies: anomalies.slice(-100).reverse(),
  };
}

export function createEventStore({ filePath, retentionDays = 30 }) {
  if (!filePath) throw new Error('event store filePath is required');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  const cutoff = () => Date.now() - retentionMs;
  let events = [];

  if (fs.existsSync(filePath)) {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    events = lines
      .filter(Boolean)
      .map((line) => {
        try { return sanitizeEvent(JSON.parse(line)); } catch { return undefined; }
      })
      .filter((event) => event && Date.parse(event.time) >= cutoff());
  }

  function compact() {
    events = events.filter((event) => Date.parse(event.time) >= cutoff());
    const tempPath = filePath + '.tmp';
    const text = events.length ? events.map((event) => JSON.stringify(event)).join('\n') + '\n' : '';
    fs.writeFileSync(tempPath, text, { mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  }

  compact();
  let writesSinceCompact = 0;

  return {
    record(input) {
      const event = sanitizeEvent(input);
      if (!event) return;
      events.push(event);
      fs.appendFileSync(filePath, JSON.stringify(event) + '\n', { mode: 0o600 });
      writesSinceCompact += 1;
      if (writesSinceCompact >= 500) {
        compact();
        writesSinceCompact = 0;
      }
    },
    summary(days = retentionDays) {
      const boundedDays = Math.max(1, Math.min(retentionDays, Number(days) || retentionDays));
      return summarize(events, boundedDays);
    },
    size() {
      return events.length;
    },
    compact,
  };
}
