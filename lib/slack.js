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
