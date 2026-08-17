import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

class RequestBodyTooLargeError extends Error {
  constructor(limit) {
    super('request body exceeds ' + limit + ' bytes');
    this.name = 'RequestBodyTooLargeError';
  }
}

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(name + ' must be a positive integer');
  }
  return number;
}

export function loadConfig(env = process.env) {
  if (!env.UPSTREAM_BASE_URL) throw new Error('UPSTREAM_BASE_URL is required');
  const upstreamBaseUrl = new URL(env.UPSTREAM_BASE_URL);
  if (!['http:', 'https:'].includes(upstreamBaseUrl.protocol)) {
    throw new Error('UPSTREAM_BASE_URL must use http or https');
  }
  return {
    host: env.HOST || '127.0.0.1',
    port: positiveInteger(env.PORT, 8787, 'PORT'),
    upstreamBaseUrl,
    firstByteTimeoutMs: positiveInteger(env.FIRST_BYTE_TIMEOUT_MS, 45000, 'FIRST_BYTE_TIMEOUT_MS'),
    nonStreamingFirstByteTimeoutMs: positiveInteger(env.NON_STREAMING_FIRST_BYTE_TIMEOUT_MS, 120000, 'NON_STREAMING_FIRST_BYTE_TIMEOUT_MS'),
    idleTimeoutMs: positiveInteger(env.IDLE_TIMEOUT_MS, 180000, 'IDLE_TIMEOUT_MS'),
    maxAttempts: positiveInteger(env.MAX_ATTEMPTS, 2, 'MAX_ATTEMPTS'),
    maxRequestBodyBytes: positiveInteger(env.MAX_REQUEST_BODY_BYTES, 64 * 1024 * 1024, 'MAX_REQUEST_BODY_BYTES'),
    eventRetentionDays: Math.min(30, positiveInteger(env.EVENT_RETENTION_DAYS, 30, 'EVENT_RETENTION_DAYS')),
    eventStorePath: env.EVENT_STORE_PATH || path.resolve(env.DATA_DIR || '.data', 'events.jsonl'),
  };
}

function log(logger, level, event, fields = {}) {
  logger(JSON.stringify({ time: new Date().toISOString(), level, event, ...fields }));
}

function copyRequestHeaders(headers) {
  const output = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    output.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  return output;
}

function copyResponseHeaders(headers, response) {
  const setCookies = headers.getSetCookie?.() || [];
  for (const [name, value] of headers) {
    const lowerName = name.toLowerCase();
    if (lowerName === 'set-cookie' || HOP_BY_HOP_HEADERS.has(lowerName)) continue;
    response.setHeader(name, value);
  }
  if (setCookies.length) response.setHeader('set-cookie', setCookies);
}

function targetUrl(base, requestUrl) {
  const incoming = new URL(requestUrl || '/', 'http://localhost');
  const basePath = base.pathname.replace(/\/$/, '');
  let pathname = incoming.pathname;
  if (pathname === basePath) pathname = '/';
  else if (basePath && basePath !== '/' && pathname.startsWith(basePath + '/')) {
    pathname = pathname.slice(basePath.length);
  }
  const target = new URL(base.toString());
  target.pathname = pathname === '/' ? (basePath || '/') : basePath + (pathname.startsWith('/') ? pathname : '/' + pathname);
  target.search = incoming.search;
  return target;
}

async function readBody(request, limit) {
  const contentLength = Number(request.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > limit) {
    throw new RequestBodyTooLargeError(limit);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new RequestBodyTooLargeError(limit);
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks, size) : undefined;
}

async function fetchFirstChunk({ url, method, headers, body, timeoutMs, downstreamSignal }) {
  const attemptController = new AbortController();
  const signal = AbortSignal.any([downstreamSignal, attemptController.signal]);
  const timeout = setTimeout(() => attemptController.abort(new Error('first byte timeout')), timeoutMs);
  try {
    const response = await fetch(url, { method, headers, body, signal, redirect: 'manual' });
    if (!response.body) return { response, reader: undefined, first: undefined, attemptController };
    const reader = response.body.getReader();
    const first = await reader.read();
    return { response, reader, first, attemptController };
  } finally {
    clearTimeout(timeout);
  }
}

async function readWithIdleTimeout(reader, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('stream idle timeout')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function waitForDrain(response) {
  if (response.destroyed) return Promise.reject(new Error('downstream closed'));
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      response.off('drain', onDrain);
      response.off('close', onClose);
      response.off('error', onError);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error('downstream closed')); };
    const onError = (error) => { cleanup(); reject(error); };
    response.once('drain', onDrain);
    response.once('close', onClose);
    response.once('error', onError);
  });
}

function canRetryStatus(status) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function isStreamingRequest(body, headers) {
  if (!body || !headers.get('content-type')?.toLowerCase().includes('application/json')) return false;
  try {
    return JSON.parse(body.toString('utf8')).stream === true;
  } catch {
    return false;
  }
}

function firstByteTimeoutForRequest(config, body, headers) {
  return isStreamingRequest(body, headers)
    ? config.firstByteTimeoutMs
    : config.nonStreamingFirstByteTimeoutMs;
}

function createSseCompletionDetector(enabled) {
  if (!enabled) return { push() {}, complete: true };
  const decoder = new TextDecoder();
  let carry = '';
  let complete = false;
  return {
    push(chunk, final = false) {
      if (complete) return;
      const text = carry + decoder.decode(chunk, { stream: !final });
      if (/(?:^|\r?\n)data:\s*\[DONE\](?:\r?\n|$)/.test(text)
        || /(?:^|\r?\n)event:\s*response\.completed(?:\r?\n|$)/.test(text)
        || /["']type["']\s*:\s*["']response\.completed["']/.test(text)) {
        complete = true;
      }
      carry = text.slice(-256);
    },
    get complete() { return complete; },
  };
}

function errorReason(error, downstreamSignal) {
  if (downstreamSignal.aborted) return 'downstream_cancelled';
  if (error?.message === 'first byte timeout') return 'first byte timeout';
  if (error?.message === 'stream idle timeout') return 'stream idle timeout';
  if (error?.message === 'stream ended before completion') return 'stream ended before completion';
  if (error?.message === 'downstream closed') return 'downstream closed';
  return 'upstream_transport_error';
}

function sendJson(response, statusCode, payload) {
  if (response.destroyed || response.headersSent) return;
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload));
}

function rejectOversizedRequest(request, response, error) {
  if (response.destroyed || response.headersSent) return;
  response.statusCode = 413;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('connection', 'close');
  request.resume();
  response.end(JSON.stringify({ error: 'request_body_too_large', message: error.message }), () => {
    if (!request.destroyed) request.destroy();
  });
}

export function createProxyServer(config, { logger = console.log, routeHandler } = {}) {
  return http.createServer(async (request, response) => {
    const requestId = randomUUID();
    response.setHeader('x-watchdog-request-id', requestId);

    if (routeHandler?.(request, response)) return;

    if (request.url === '/health') {
      return sendJson(response, 200, { ok: true });
    }

    const downstreamController = new AbortController();
    let responseFinished = false;
    response.once('finish', () => { responseFinished = true; });
    response.once('close', () => {
      if (!responseFinished && !downstreamController.signal.aborted) {
        downstreamController.abort(new Error('downstream closed'));
      }
    });
    request.once('aborted', () => {
      if (!downstreamController.signal.aborted) downstreamController.abort(new Error('downstream aborted'));
    });

    const startedAt = Date.now();
    let body;
    try {
      body = await readBody(request, config.maxRequestBodyBytes);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return rejectOversizedRequest(request, response, error);
      }
      if (downstreamController.signal.aborted) return;
      return sendJson(response, 400, { error: 'invalid_request_body', message: error.message });
    }

    const url = targetUrl(config.upstreamBaseUrl, request.url);
    const headers = copyRequestHeaders(request.headers);
    headers.set('x-client-request-id', String(requestId));
    const streamingRequest = isStreamingRequest(body, headers);
    const firstByteTimeoutMs = firstByteTimeoutForRequest(config, body, headers);
    let lastError;

    for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
      if (downstreamController.signal.aborted) return;
      let result;
      let responseCommitted = false;
      log(logger, 'info', 'upstream_attempt_started', { requestId, attempt, method: request.method, path: url.pathname });
      try {
        result = await fetchFirstChunk({
          url,
          method: request.method,
          headers,
          body,
          timeoutMs: firstByteTimeoutMs,
          downstreamSignal: downstreamController.signal,
        });

        if (canRetryStatus(result.response.status) && attempt < config.maxAttempts) {
          result.attemptController.abort(new Error('retryable upstream status'));
          await result.reader?.cancel().catch(() => {});
          log(logger, 'warn', 'upstream_retry', { requestId, attempt, reason: 'status_' + result.response.status });
          continue;
        }

        response.statusCode = result.response.status;
        response.statusMessage = result.response.statusText;
        copyResponseHeaders(result.response.headers, response);
        responseCommitted = true;
        const completionDetector = createSseCompletionDetector(
          streamingRequest && result.response.headers.get('content-type')?.toLowerCase().includes('text/event-stream'),
        );
        response.flushHeaders();
        log(logger, 'info', 'upstream_first_byte', {
          requestId,
          attempt,
          status: result.response.status,
          latencyMs: Date.now() - startedAt,
        });

        if (!result.reader || !result.first || result.first.done) {
          completionDetector.push(undefined, true);
          if (!completionDetector.complete) throw new Error('stream ended before completion');
          response.end();
          log(logger, 'info', 'request_complete', { requestId, attempt, durationMs: Date.now() - startedAt });
          return;
        }

        completionDetector.push(result.first.value);
        if (!response.write(Buffer.from(result.first.value))) await waitForDrain(response);
        while (true) {
          const chunk = await readWithIdleTimeout(result.reader, config.idleTimeoutMs);
          if (chunk.done) {
            completionDetector.push(undefined, true);
            if (!completionDetector.complete) throw new Error('stream ended before completion');
            response.end();
            log(logger, 'info', 'request_complete', { requestId, attempt, durationMs: Date.now() - startedAt });
            return;
          }
          completionDetector.push(chunk.value);
          if (!response.write(Buffer.from(chunk.value))) await waitForDrain(response);
        }
      } catch (error) {
        lastError = error;
        result?.attemptController.abort(error);
        await result?.reader?.cancel(error).catch(() => {});
        const reason = errorReason(error, downstreamController.signal);

        if (downstreamController.signal.aborted) {
          log(logger, 'info', 'downstream_cancelled', { requestId, attempt, durationMs: Date.now() - startedAt });
          return;
        }
        if (responseCommitted || response.headersSent) {
          log(logger, 'error', reason === 'stream idle timeout' ? 'upstream_stream_stalled' : 'stream_error_after_commit', {
            requestId,
            attempt,
            reason,
            idleTimeoutMs: reason === 'stream idle timeout' ? config.idleTimeoutMs : undefined,
          });
          response.destroy(error);
          return;
        }

        log(logger, attempt < config.maxAttempts ? 'warn' : 'error', attempt < config.maxAttempts ? 'upstream_retry' : 'upstream_failed', {
          requestId,
          attempt,
          reason,
        });
        if (attempt < config.maxAttempts) continue;
      }
    }

    sendJson(response, 504, {
      error: 'upstream_unavailable',
      message: lastError?.message || 'upstream request failed',
      requestId,
    });
  });
}
