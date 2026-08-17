import { createProxyServer, loadConfig } from './proxy.js';
import { createEventStore } from './event-store.js';
import { handleDashboardRequest } from './dashboard.js';

const config = loadConfig();
const store = createEventStore({
  filePath: config.eventStorePath,
  retentionDays: config.eventRetentionDays,
});

function logger(line) {
  console.log(line);
  try {
    store.record(JSON.parse(line));
  } catch (error) {
    console.error(JSON.stringify({ event: 'event_store_write_failed', message: error.message }));
  }
}

const server = createProxyServer(config, {
  logger,
  routeHandler: (request, response) => handleDashboardRequest(request, response, { store, config }),
});

server.listen(config.port, config.host, () => {
  console.log(JSON.stringify({
    event: 'watchdog_listening',
    url: 'http://' + config.host + ':' + config.port + '/v1',
    dashboard: 'http://' + config.host + ':' + config.port + '/dashboard',
    upstreamConfigured: true,
    streamingFirstByteTimeoutMs: config.firstByteTimeoutMs,
    nonStreamingFirstByteTimeoutMs: config.nonStreamingFirstByteTimeoutMs,
    idleTimeoutMs: config.idleTimeoutMs,
    maxAttempts: config.maxAttempts,
    maxRequestBodyBytes: config.maxRequestBodyBytes,
    eventRetentionDays: config.eventRetentionDays,
    persistedEvents: store.size(),
  }));
});

function shutdown(signal) {
  console.log(JSON.stringify({ event: 'watchdog_stopping', signal }));
  try { store.compact(); } catch (error) {
    console.error(JSON.stringify({ event: 'event_store_compact_failed', message: error.message }));
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
