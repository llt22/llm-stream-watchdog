const USAGE_REFRESH_MS = 60_000;
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const USAGE_REQUEST_TIMEOUT_MS = 5_000;

function parseKeys(value) {
  return String(value || '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
}

function hasNoQuota(body) {
  const quota = body?.quota;
  if (quota) {
    const remaining = Number(quota.remaining);
    if (Number.isFinite(remaining) && remaining <= 0) return true;
  }
  return Array.isArray(body?.rate_limits)
    && body.rate_limits.some((item) => {
      const remaining = Number(item?.remaining);
      return Number.isFinite(remaining) && remaining <= 0;
    });
}

export function createKeyPools({ upstreamBaseUrl, claudeKeys, openaiKeys, logger = () => {} }) {
  const usageUrl = new URL(upstreamBaseUrl.toString());
  usageUrl.pathname = usageUrl.pathname.replace(/\/$/, '') + '/usage';
  usageUrl.search = '?days=1&timezone=Asia%2FShanghai';
  const pools = new Map([
    ['claude', createPool('claude', claudeKeys)],
    ['openai', createPool('openai', openaiKeys)],
  ]);

  function createPool(name, configuredKeys) {
    return {
      name,
      keys: (configuredKeys || []).map((key, index) => ({ key, label: name + '-key-' + (index + 1), exhausted: false, cooldownUntil: 0, usageCheckedAt: 0 })),
      cursor: 0,
    };
  }

  async function refresh(item) {
    if (Date.now() - item.usageCheckedAt < USAGE_REFRESH_MS) return;
    item.usageCheckedAt = Date.now();
    try {
      const response = await fetch(usageUrl, {
        headers: { authorization: 'Bearer ' + item.key, accept: 'application/json', 'user-agent': 'llm-stream-watchdog/1.0' },
        signal: AbortSignal.timeout(USAGE_REQUEST_TIMEOUT_MS),
      });
      if (response.ok) {
        const body = await response.json();
        item.exhausted = hasNoQuota(body);
        logger(JSON.stringify({ event: 'key_usage_checked', pool: item.label, exhausted: item.exhausted }));
      }
    } catch (error) {
      logger(JSON.stringify({ event: 'key_usage_check_failed', pool: item.label, message: error.message }));
    }
  }

  async function select(group) {
    const pool = pools.get(group) || pools.get('openai');
    if (!pool || pool.keys.length === 0) return undefined;
    for (const item of pool.keys) await refresh(item);
    const now = Date.now();
    const available = pool.keys.filter((item) => !item.exhausted && item.cooldownUntil <= now);
    if (!available.length) return undefined;
    const item = available[pool.cursor % available.length];
    pool.cursor += 1;
    return { value: item.key, label: item.label, group: pool.name };
  }

  function reportUpstreamStatus(group, key, status) {
    const pool = pools.get(group) || pools.get('openai');
    const item = pool?.keys.find((candidate) => candidate.key === key);
    if (!item) return;
    if (status === 429) item.cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
    if (status === 429) item.usageCheckedAt = 0;
  }

  return {
    hasConfiguredKeys(group) { return (pools.get(group)?.keys.length || 0) > 0; },
    select,
    async selectAny() {
      return (await select('openai')) || (await select('claude'));
    },
    hasAnyConfiguredKeys() { return [...pools.values()].some((pool) => pool.keys.length > 0); },
    reportUpstreamStatus,
    usageUrl: usageUrl.toString(),
  };
}

export function modelKeyGroup(model) {
  return String(model || '').toLowerCase().startsWith('claude-') ? 'claude' : 'openai';
}

export function parseKeyList(value) {
  return parseKeys(value);
}
