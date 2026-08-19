# LLM Stream Watchdog

A small local OpenAI-compatible proxy that detects stalled upstream model responses. It is designed for clients such as Codex, OMP, and DSH that can use a custom OpenAI-compatible base URL.

## What it does

- Proxies `/v1/responses`, `/v1/chat/completions`, `/v1/models`, and other paths transparently.
- Retries connection failures, first-byte stalls, 429, 502, 503, and 504 responses before any response body is exposed to the client.
- Terminates a stream that stalls after partial output instead of hanging forever or replaying potentially unsafe tool-call content.
- Cancels upstream generation promptly when the downstream client disconnects or interrupts a turn.
- Does not inspect prompts, responses, or tool calls.
- Logs timing, status, retry reason, and request IDs without logging bodies or credentials.

## Requirements

- Node.js 22.19 or newer

If Node is installed with nvm on macOS, run commands through a login shell:

```sh
zsh -lc 'node --version'
```

## Start

Configure the upstream URL in the shell that starts the proxy. To enable pool-managed key selection, export separate Claude and OpenAI key pools in the same shell; leave both empty to use credentials supplied by each client. Keys are never logged or committed:

```sh
cd llm-stream-watchdog
export UPSTREAM_BASE_URL='https://your-provider.example/v1'
# Optional: export UPSTREAM_CLAUDE_API_KEYS='key_a,key_b'
# Optional: export UPSTREAM_OPENAI_API_KEYS='key_c,key_d'
# Optional: export PROXY_ACCESS_TOKEN='client_token'   # require clients to send this token
npm start
```

The local base URL is:

```text
http://127.0.0.1:8787/v1
```

Configure Codex, OMP, DSH, or another OpenAI-compatible client to use that base URL. When key pools are configured, `claude-*` models use the Claude pool and other models use the OpenAI pool. Without a configured pool, the proxy remains compatible with client-supplied authentication headers.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `UPSTREAM_BASE_URL` | required | Target OpenAI-compatible API |
| `UPSTREAM_CLAUDE_API_KEYS` | empty | Comma-separated Claude upstream keys; uses the same key until 429 forces a switch |
| `UPSTREAM_OPENAI_API_KEYS` | empty | Comma-separated non-Claude upstream keys; uses the same key until 429 forces a switch |
| `PROXY_ACCESS_TOKEN` | empty | Comma-separated tokens clients must send (Authorization: Bearer or x-api-key); empty disables downstream auth |
| `HOST` | `127.0.0.1` | Local bind host |
| `PORT` | `8787` | Local bind port |
| `FIRST_BYTE_TIMEOUT_MS` | `45000` | Maximum first-body-byte wait for JSON requests with `stream: true` |
| `NON_STREAMING_FIRST_BYTE_TIMEOUT_MS` | `120000` | Maximum first-body-byte wait for non-streaming or unknown requests |
| `IDLE_TIMEOUT_MS` | `180000` | Maximum gap between upstream body chunks |
| `MAX_ATTEMPTS` | `6` | Total attempts before output starts (retries wait 10s between attempts) |
| `MAX_REQUEST_BODY_BYTES` | `67108864` | Maximum buffered request body size (64 MiB) |
| `EVENT_RETENTION_DAYS` | `30` | Anonymous dashboard history retention (hard-capped at 30 days) |
| `EVENT_STORE_PATH` | `.data/events.jsonl` | Persistent anonymous event file |

Long-running local commands are not affected. The timers exist only while this proxy has an active HTTP request to the upstream model API. Streaming requests use the shorter timeout so a silent upstream is retried quickly; non-streaming requests retain a conservative timeout because healthy long-reasoning calls may not emit body bytes until completion.

## Local dashboard

Open [http://127.0.0.1:8787/dashboard](http://127.0.0.1:8787/dashboard) to view request counts, retry recovery, timeout/stall history, latency percentiles, daily anomaly trends, and recent anomalies. The dashboard stores only whitelisted metadata; it never stores prompts, response bodies, API keys, or Authorization headers. History is retained for 30 days by default.

## Run persistently with Docker Compose

Copy the public example and set your upstream before starting:

```sh
cp .env.example .env
# Edit UPSTREAM_BASE_URL in .env
```

The Compose service binds only to the local loopback interface, runs as a non-root user with a read-only filesystem, has a health check, rotates logs, and restarts automatically whenever Docker Desktop is running.

```sh
cd llm-stream-watchdog
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:8787/health
```

The Compose example leaves both key pools empty, so clients such as DSH and OMP send their selected credentials with each request. To enable proxy-managed key selection, fill the two key-pool variables in `.env` before starting; those keys stay inside the container and are never logged. The proxy keeps using the current key until a 429 moves it to the next available key. To stop the service intentionally:

```sh
docker compose down
```

To inspect structured logs:

```sh
docker compose logs --tail=100 -f watchdog
```

## Verify

```sh
npm run check
npm test
docker compose config --quiet
docker build -t llm-stream-watchdog:local .
curl http://127.0.0.1:8787/health
```

## Current safety boundary

A request is retried only before any upstream body bytes reach the client. If a stream already emitted content and then stalls, the proxy closes that response explicitly. It does not replay partial text or partially emitted tool calls.
