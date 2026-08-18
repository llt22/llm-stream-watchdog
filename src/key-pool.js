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
  return false;
}

function quotaSnapshot(body) {
  const source = body?.quota && typeof body.quota === 'object' ? body.quota : body;
  const pick = (key) => Number.isFinite(Number(source?.[key])) ? Number(source[key]) : undefined;
  const quota = { remaining: pick('remaining'), limit: pick('limit'), used: pick('used') };
  if (Array.isArray(body?.rate_limits)) {
    quota.rateLimits = body.rate_limits.map((item) => ({
      window: typeof item?.window === 'string' ? item.window : undefined,
      remaining: Number.isFinite(Number(item?.remaining)) ? Number(item.remaining) : undefined,
      limit: Number.isFinite(Number(item?.limit)) ? Number(item.limit) : undefined,
      used: Number.isFinite(Number(item?.used)) ? Number(item.used) : undefined,
    }));
  }
  return Object.values(quota).some((value) => value !== undefined && (!Array.isArray(value) || value.length)) ? quota : undefined;
}

function maskedKey(key) {
  return key.length > 10 ? key.slice(0, 4) + '...' + key.slice(-4) : '****';
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
      keys: (configuredKeys || []).map((key, index) => ({ key, label: name + '-key-' + (index + 1), masked: maskedKey(key), exhausted: false, cooldownUntil: 0, usageCheckedAt: 0, quota: undefined })),
      preferredLabel: undefined,
      activeLabel: undefined,
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
        item.quota = quotaSnapshot(body);
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
    if (pool.preferredLabel) {
      const preferred = available.find((item) => item.label === pool.preferredLabel);
      if (!preferred) return undefined;
      pool.activeLabel = preferred.label;
      return { value: preferred.key, label: preferred.label, group: pool.name };
    }
    if (pool.activeLabel) {
      const active = available.find((item) => item.label === pool.activeLabel);
      if (active) {
        return { value: active.key, label: active.label, group: pool.name };
      }
    }
    const item = available[0];
    pool.activeLabel = item.label;
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
    async status() {
      const result = {};
      for (const [group, pool] of pools) {
        for (const item of pool.keys) await refresh(item);
        result[group] = {
          preferredLabel: pool.preferredLabel || null,
          activeLabel: pool.activeLabel || null,
          keys: pool.keys.map((item) => ({
            label: item.label,
            masked: item.masked,
            exhausted: item.exhausted,
            cooldownUntil: item.cooldownUntil || null,
            quota: item.quota || null,
          })),
        };
      }
      return result;
    },
    setPreferred(group, label) {
      const pool = pools.get(group);
      if (!pool) throw new Error('unknown key pool');
      if (label !== null && label !== undefined && !pool.keys.some((item) => item.label === label)) {
        throw new Error('unknown key label');
      }
      pool.preferredLabel = label || undefined;
    },
    usageUrl: usageUrl.toString(),
  };
}

export function modelKeyGroup(model) {
  return String(model || '').toLowerCase().startsWith('claude-') ? 'claude' : 'openai';
}

export function parseKeyList(value) {
  return parseKeys(value);
}
