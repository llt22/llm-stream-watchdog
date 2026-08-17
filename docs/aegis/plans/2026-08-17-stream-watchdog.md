# LLM Stream Watchdog Implementation Plan

**Goal:** Build a local OpenAI-compatible proxy that prevents silent upstream stalls from hanging Codex, OMP, DSH, and similar clients.

**Architecture:** A dependency-free Node.js HTTP proxy forwards requests to one configured upstream. It retries only before any response body is exposed to the client. Once output starts, an idle watchdog terminates a stalled stream with an explicit connection close instead of replaying partial content.

**Tech Stack:** Node.js 24 built-in HTTP, Fetch, Web Streams, and node:test.

**Baseline/Authority Refs:** User-approved design in the 2026-08-17 conversation; verified against an OpenAI-compatible upstream.

**Compatibility Boundary:** Preserve request methods, paths, query strings, bodies, authorization headers, upstream status codes, and SSE bytes for /v1/responses, /v1/chat/completions, and /v1/models. Do not inspect prompts or tool calls.

**TDD Route:**
- Mode: off
- Decision: skipped
- Strict authority: not applicable
- Test posture: post-change regression
- Reason: no explicit strict TDD request
- Verification: npm run check && npm test

## Tasks

1. Create a dependency-free proxy owner in src/proxy.js with configuration validation, safe header forwarding, first-byte timeout, idle timeout, and bounded pre-output retry.
2. Create src/server.js as the CLI entry point with environment-based configuration and a local health endpoint.
3. Add node:test integration tests with an in-process mock upstream covering transparent forwarding, first-attempt stall retry, partial-stream stall termination, and long gaps outside upstream requests.
4. Document setup for Codex/OMP/DSH clients without storing credentials.
5. Run syntax checks, tests, and a real upstream /v1/models smoke test through the proxy using an environment-only credential.

## Verification

```sh
zsh -lc 'cd /Users/apple/WebstormProjects/llm-stream-watchdog && npm run check && npm test'
```

## Risks and Retirement

- Partial streams are not replayed; this avoids duplicate content and tool-call corruption.
- Timeouts are configurable because models may legitimately think silently.
- No old path is retired; clients can switch back by restoring their original base URL.
