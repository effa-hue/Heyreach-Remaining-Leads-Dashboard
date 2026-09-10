'use strict';

const { configuredClients } = require('../../lib/clients');
const { addLeadTags } = require('../../lib/heyreach');
const { verifySlackSignature } = require('../../lib/slack');
const { buildResolvedMessage, ADDRESSED_ACTION } = require('../../lib/followup-message');

/**
 * Slack sends the interaction body as `application/x-www-form-urlencoded`, and Vercel's
 * Node runtime would helpfully parse it into `req.body` -- which destroys the exact bytes
 * the signature is computed over. Re-encoding a parsed form does not reliably reproduce
 * Slack's percent-escaping, so the digest stops matching and every legitimate click gets
 * rejected. Turning the parser off and reading the stream is the only sound route.
 */
module.exports.config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/**
 * Handles button presses on follow-up reminders.
 *
 * Two buttons ride on each reminder. "Open in HeyReach" is a plain link button -- Slack
 * still posts an interaction for it, which is acknowledged and ignored. "Addressed" is the
 * one that does work: it tags the lead in HeyReach and collapses the message to a single
 * resolved line.
 *
 * Tagging the lead rather than recording the click in a database is what keeps the tracker
 * stateless. `Addressed` is in the client's `excludeTags`, so the next run simply does not
 * see that thread any more -- the same mechanism that already drops `Not interested`. The
 * state lives in the inbox, where the team is already looking, and it is visible and
 * reversible there rather than trapped in a table nobody can see.
 *
 * Slack allows three seconds. The tag write is a single HeyReach call, so it happens
 * inline and the replacement message is returned as the response body itself -- no
 * `response_url` round trip. That ordering is forced rather than chosen: a Vercel function
 * is frozen the moment it responds, so anything deferred until "after the ack" may simply
 * never run.
 */
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('method not allowed');

  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    console.error('[interactivity] SLACK_SIGNING_SECRET is not set; refusing to run');
    return res.status(500).send('not configured');
  }

  const rawBody = await readRawBody(req);
  const ok = verifySlackSignature({
    signingSecret,
    rawBody,
    timestamp: req.headers['x-slack-request-timestamp'],
    signature: req.headers['x-slack-signature'],
  });
  // This endpoint is public and carries no bearer token, so a bad signature is the only
  // thing between a stranger and the ability to mark leads addressed.
  if (!ok) return res.status(401).send('bad signature');

  let payload;
  try {
    payload = JSON.parse(new URLSearchParams(rawBody).get('payload'));
  } catch {
    return res.status(400).send('unparseable payload');
  }

  const action = (payload.actions ?? [])[0];
  if (payload.type !== 'block_actions' || !action) return res.status(200).send('');
  // The link button is a no-op here: Slack posts an interaction for it, and an
  // unacknowledged interaction shows the user a red warning even though the link worked.
  if (action.action_id !== ADDRESSED_ACTION) return res.status(200).send('');

  let meta;
  try {
    meta = JSON.parse(action.value);
  } catch {
    return res.status(400).send('unparseable action value');
  }

  const userId = payload.user?.id;

  let tagged = false;
  let tagError = null;
  try {
    const client = configuredClients().find((c) => c.key === meta.c);
    if (!client) throw new Error(`unknown client "${meta.c}" or its HeyReach key is unset`);
    await addLeadTags(client.apiKey, {
      linkedInId: meta.li,
      profileUrl: meta.u,
      tags: [client.followUp.addressedTag],
    });
    tagged = true;
  } catch (err) {
    // The click still resolves the message. The sender has said they dealt with it, and
    // throwing that away because a tag write failed would be worse than a thread that
    // comes back once. The message says what happened rather than pretending it worked.
    tagError = err.message;
    console.error('[interactivity] tagging failed:', err);
  }

  // Responding to the interaction with a message payload replaces the original in place.
  const replacement = buildResolvedMessage({
    leadName: meta.n,
    company: meta.co,
    userId,
    tagged,
    tagError,
  });
  return res.status(200).json({ replace_original: true, ...replacement });
};
