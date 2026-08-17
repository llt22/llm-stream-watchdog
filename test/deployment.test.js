import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Docker deployment remains loopback-only, persistent, and non-root', () => {
  const compose = fs.readFileSync(new URL('../compose.yaml', import.meta.url), 'utf8');
  const dockerfile = fs.readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.ok(compose.includes('127.0.0.1:8787:8787'));
  assert.ok(compose.includes('watchdog-data:/data'));
  assert.ok(compose.includes('read_only: true'));
  assert.ok(compose.includes('no-new-privileges:true'));
  assert.match(compose, /cap_drop:\n\s+- ALL/);
  assert.ok(compose.includes('UPSTREAM_BASE_URL: ${UPSTREAM_BASE_URL:?'));
  assert.ok(dockerfile.includes('USER node'));
  assert.ok(dockerfile.includes('chown node:node /data'));
});
