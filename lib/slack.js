'use strict';

/** Post to a channel with a bot token (needs the `chat:write` scope). */
async function postMessage({ token, channel, text, blocks }) {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ channel, text, blocks, unfurl_links: false, unfurl_media: false }),
  });
  const json = await res.json().catch(() => ({}));
  // Slack answers 200 with ok:false for real failures, so the status code alone proves nothing.
  if (!json.ok) throw new Error(`slack chat.postMessage failed: ${json.error ?? `HTTP ${res.status}`}`);
  return { ts: json.ts, channel: json.channel };
}

module.exports = { postMessage };

/**
 * Is this really Slack calling?
 *
 * The interactivity endpoint is public and unauthenticated -- Slack cannot present a
 * bearer token the way the crons do -- so the signature is the only thing standing between
 * a stranger and the ability to mark leads addressed. Verified per Slack's scheme: HMAC
 * SHA-256 over `v0:<timestamp>:<raw body>` keyed with the signing secret.
 *
 * `rawBody` must be the bytes exactly as they arrived. Re-encoding a parsed form changes
 * the percent-escaping and the digest stops matching, which is why the handler turns
 * Vercel's body parser off.
 *
 * The timestamp check is not ceremony: without it a captured request could be replayed
 * indefinitely. Five minutes is Slack's own recommendation.
 */
function verifySlackSignature({ signingSecret, rawBody, timestamp, signature, now = Date.now() }) {
  if (!signingSecret || !rawBody || !timestamp || !signature) return false;
  const age = Math.abs(now / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;

  const crypto = require('crypto');
  const expected =
    'v0=' +
    crypto.createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex');

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  // Length must match before timingSafeEqual, which throws on a mismatch rather than
  // returning false.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports.verifySlackSignature = verifySlackSignature;
