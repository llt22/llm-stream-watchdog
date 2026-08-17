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
]);

function sanitizePath(value) {
  return ['/v1/responses', '/v1/chat/completions', '/v1/models'].includes(value) ? value : '(other)';
}

function sanitizeReason(value) {
  const known = ['first byte timeout', 'stream idle timeout', 'stream ended before completion', 'downstream closed', 'upstream_transport_error'];
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

function summarize(events, days, activeRequestIds = new Set()) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const scoped = events.filter((event) => Date.parse(event.time) >= cutoff);
  const requests = new Map();
  const daily = new Map();
  const anomalies = [];

  for (const event of scoped) {
    if (event.requestId) {
      const request = requests.get(event.requestId) || { attempts: 0, completed: false, cancelled: false, failed: false, started: false };
      if (event.event === 'upstream_attempt_started') {
        request.attempts = Math.max(request.attempts, event.attempt || 1);
        if (event.attempt === 1) {
          request.started = true;
          request.startedAt = event.time;
          request.day = dayKey(event.time);
          request.requestId = event.requestId;
          request.path = event.path;
          request.method = event.method;
        }
      }
      if (event.event === 'upstream_first_byte' && typeof event.latencyMs === 'number') request.firstByteMs = event.latencyMs;
      if (event.event === 'request_complete') {
        request.completed = true;
        request.durationMs = event.durationMs;
      }
      if (event.event === 'downstream_cancelled') request.cancelled = true;
      if (event.event === 'upstream_failed' || event.event === 'upstream_stream_stalled' || event.event === 'stream_error_after_commit') request.failed = true;
      requests.set(event.requestId, request);
    }
    const day = dayKey(event.time);
    const bucket = daily.get(day) || { date: day, requests: 0, retries: 0, anomalies: 0 };
    if (event.event === 'upstream_retry') bucket.retries += 1;
    if (ANOMALY_EVENTS.has(event.event)) bucket.anomalies += 1;
    daily.set(day, bucket);
    if (ANOMALY_EVENTS.has(event.event)) anomalies.push(event);
  }

  const requestValues = [...requests.values()].filter((request) => request.started);
  const countableRequests = requestValues.filter((request) =>
    request.completed || request.failed || request.cancelled || activeRequestIds.has(request.requestId));
  for (const request of countableRequests) {
    const bucket = daily.get(request.day) || { date: request.day, requests: 0, retries: 0, anomalies: 0 };
    bucket.requests += 1;
    daily.set(request.day, bucket);
  }
  const firstByteValues = countableRequests.map((item) => item.firstByteMs).filter(Number.isFinite);
  const durationValues = countableRequests.map((item) => item.durationMs).filter(Number.isFinite);
  const retryEvents = scoped.filter((event) => event.event === 'upstream_retry');
  const completedAfterRetry = requestValues.filter((item) => item.completed && item.attempts > 1).length;
  const completedRequests = requestValues.filter((item) => item.completed).length;
  const failedRequests = requestValues.filter((item) => item.failed && !item.completed && !item.cancelled).length;
  const cancelledRequests = requestValues.filter((item) => item.cancelled && !item.completed).length;
  const activeRequests = [...activeRequestIds].filter((requestId) => {
    const request = requests.get(requestId);
    return request?.started && !request.completed && !request.failed && !request.cancelled;
  }).length;
  const settledRequests = completedRequests + failedRequests;
  const recentAnomalies = anomalies.slice(-100).reverse().map((event) => {
    const request = event.requestId ? requests.get(event.requestId) : undefined;
    return { ...event, method: event.method || request?.method, path: event.path || request?.path };
  });

  return {
    generatedAt: new Date().toISOString(),
    days,
    totals: {
      requests: countableRequests.length,
      completed: completedRequests,
      failedRequests,
      settled: settledRequests,
      active: activeRequests,
      retries: retryEvents.length,
      recoveredAfterRetry: completedAfterRetry,
      firstByteTimeouts: retryEvents.filter((event) => event.reason === 'first byte timeout').length,
      streamStalls: scoped.filter((event) => event.event === 'upstream_stream_stalled').length,
      failures: scoped.filter((event) => event.event === 'upstream_failed' || event.event === 'stream_error_after_commit').length,
      cancelled: cancelledRequests,
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
    recentAnomalies,
  };
}

export function createEventStore({ filePath, retentionDays = 30 }) {
  if (!filePath) throw new Error('event store filePath is required');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  const cutoff = () => Date.now() - retentionMs;
  let events = [];
  const activeRequestIds = new Set();

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
      if (event.requestId && event.event === 'upstream_attempt_started' && event.attempt === 1) activeRequestIds.add(event.requestId);
      if (event.requestId && ['request_complete', 'downstream_cancelled', 'upstream_failed', 'upstream_stream_stalled', 'stream_error_after_commit'].includes(event.event)) {
        activeRequestIds.delete(event.requestId);
      }
      fs.appendFileSync(filePath, JSON.stringify(event) + '\n', { mode: 0o600 });
      writesSinceCompact += 1;
      if (writesSinceCompact >= 500) {
        compact();
        writesSinceCompact = 0;
      }
    },
    summary(days = retentionDays) {
      const boundedDays = Math.max(1, Math.min(retentionDays, Number(days) || retentionDays));
      return summarize(events, boundedDays, activeRequestIds);
    },
    size() {
      return events.length;
    },
    compact,
  };
}
