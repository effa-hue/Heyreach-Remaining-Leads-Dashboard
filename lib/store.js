'use strict';

/**
 * The one piece of state the follow-up tracker keeps: when a lead was marked Addressed.
 *
 * Everything else the tracker knows it recomputes from HeyReach, and that is still true of
 * the *fact* of being addressed -- the `Addressed` tag on the lead carries that, visibly
 * and reversibly, in the inbox. What a tag cannot carry is a timestamp. HeyReach's manual
 * `tags` are bare strings with no applied-at time (only `autoTags` have `creationTime`),
 * so without recording it somewhere there is no way to tell "addressed, and quiet since"
 * from "addressed, but they have written to us again since".
 *
 * Encoding the date into the tag name (`Addressed 2026-09-11`) was the alternative and
 * would have needed no storage at all, but it litters the workspace tag list with a new
 * tag every day, for the team, forever.
 *
 * Redis over HTTP, which both Vercel KV and Upstash speak, driven with plain `fetch` so
 * the project keeps its zero-dependency package.json. One hash per client, field keyed by
 * the lead, value an ISO instant.
 *
 * Unconfigured is a supported state, not an error: `readAddressed` returns null and the
 * caller falls back to treating the tag as a permanent exclusion, which is exactly how the
 * tracker behaved before any of this existed.
 */
function storeConfig(env = process.env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ''), token } : null;
}

async function command(cfg, args) {
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`kv ${args[0]} failed: HTTP ${res.status}${txt ? ` -> ${txt.slice(0, 120)}` : ''}`);
  }
  const json = await res.json();
  if (json.error) throw new Error(`kv ${args[0]} failed: ${json.error}`);
  return json.result;
}

const hashKey = (clientKey) => `followup:addressed:${clientKey}`;

/** A lead's identity in the hash. Prefer the id: a vanity URL can be changed by its owner. */
function leadKey(thread) {
  return thread.linkedinId ? `li:${thread.linkedinId}` : `url:${thread.profileUrl ?? ''}`;
}

/**
 * When each lead of this client was last marked Addressed, as `{ leadKey: epochMs }`.
 * Null when no store is configured -- distinct from `{}`, which means "configured, nothing
 * recorded yet". The caller has to tell those apart to pick the right fallback.
 */
async function readAddressed(clientKey, env = process.env) {
  const cfg = storeConfig(env);
  if (!cfg) return null;
  // HGETALL comes back as a flat [field, value, field, value, ...].
  const flat = (await command(cfg, ['HGETALL', hashKey(clientKey)])) ?? [];
  const out = {};
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const at = Date.parse(flat[i + 1]);
    if (!Number.isNaN(at)) out[flat[i]] = at;
  }
  return out;
}

/** Record that a lead was addressed now. Returns false when there is no store to write to. */
async function writeAddressed(clientKey, thread, at = new Date(), env = process.env) {
  const cfg = storeConfig(env);
  if (!cfg) return false;
  await command(cfg, ['HSET', hashKey(clientKey), leadKey(thread), at.toISOString()]);
  return true;
}

module.exports = { storeConfig, readAddressed, writeAddressed, leadKey, hashKey };
