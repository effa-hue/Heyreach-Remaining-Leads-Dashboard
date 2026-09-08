'use strict';

const { configuredClients } = require('../../lib/clients');
const { assessClient } = require('../../lib/capacity');
const { windowState } = require('../../lib/window');
const { buildMessage } = require('../../lib/message');
const { postMessage } = require('../../lib/slack');

/**
 * Daily LinkedIn send-capacity warning.
 *
 * Scheduled twice a day per vercel.json: once shortly before the sending window opens and
 * once around its midpoint. Which of the two fired is NOT read off the cron header — it is
 * derived from where the client's clock actually is, so a late invocation (Vercel's Hobby
 * plan may fire anywhere inside the scheduled hour) still produces an accurate message.
 *
 * Query params, all for manual testing:
 *   ?dryRun=1   compute and return the Slack payloads without posting
 *   ?force=1    ignore the send-day / after-window guards
 *   ?run=       force 'preflight' or 'midday' framing
 *   ?client=    restrict to one client key ('advance', 'makershub')
 *
 * Set SLACK_OVERRIDE_CHANNEL to send every client's alert to one destination instead of the
 * client channels -- a channel id, or a user id to route it as a DM (chat.postMessage accepts
 * a user id with only the chat:write scope). Unset it to go back to the client channels; no
 * code change either way.
 */
module.exports = async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return res.status(500).json({ ok: false, error: 'CRON_SECRET is not set; refusing to run' });
  }
  const presented = req.headers.authorization ?? (req.headers['x-cron-secret'] ? `Bearer ${req.headers['x-cron-secret']}` : '');
  if (presented !== `Bearer ${secret}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const q = req.query ?? {};
  const dryRun = q.dryRun === '1' || q.dryRun === 'true';
  const force = q.force === '1' || q.force === 'true';
  const runOverride = q.run === 'preflight' || q.run === 'midday' ? q.run : null;
  const postAllClear = process.env.POST_ALL_CLEAR === '1';
  const token = process.env.SLACK_BOT_TOKEN;
  const override = process.env.SLACK_OVERRIDE_CHANNEL || null;
  const now = new Date();

  let clients = configuredClients();
  if (q.client) clients = clients.filter((c) => c.key === q.client);
  if (clients.length === 0) {
    return res.status(500).json({ ok: false, error: 'no clients configured — check HEYREACH_KEY_* env vars' });
  }
  if (!token && !dryRun) {
    return res.status(500).json({ ok: false, error: 'SLACK_BOT_TOKEN is not set' });
  }

  const results = await Promise.all(
    clients.map(async (client) => {
      const state = windowState(client, now);
      const run = runOverride ?? (state.beforeWindow ? 'preflight' : 'midday');

      if (!force && !state.isSendDay) {
        return { client: client.key, skipped: `not a send day (${state.local.weekdayName})` };
      }
      if (!force && state.afterWindow) {
        return { client: client.key, skipped: 'sending window already closed' };
      }

      try {
        const assessment = await assessClient(client);
        const message = buildMessage({ assessment, state, run, postAllClear, redirectedFrom: override ? client.slackChannelName : null });
        const summary = {
          client: client.key,
          run,
          destination: override ? `${override} (override)` : client.slackChannelName,
          elapsedPct: state.elapsedPct,
          totals: assessment.totals,
          atRisk: assessment.atRisk.map((s) => ({ name: s.name, shortfall: s.shortfall, queued: s.queued, sentToday: s.sentToday })),
          blocked: assessment.blocked.map((s) => ({ name: s.name, reason: s.blockedReason })),
        };

        if (!message) return { ...summary, posted: false, reason: 'nothing to warn about' };
        if (dryRun) return { ...summary, posted: false, dryRun: true, message };

        const channel = override ?? client.slackChannel;
        const sent = await postMessage({ token, channel, ...message });
        return { ...summary, posted: true, channel: sent.channel ?? channel, ts: sent.ts };
      } catch (err) {
        console.error(`[capacity-check] ${client.key} failed:`, err);
        return { client: client.key, run, error: err.message };
      }
    })
  );

  // A silent failure is the dangerous one: no warning looks identical to nothing being wrong.
  // Surface it in an ops channel when one is configured.
  const failures = results.filter((r) => r.error);
  if (failures.length > 0 && token && !dryRun && process.env.SLACK_OPS_CHANNEL) {
    try {
      await postMessage({
        token,
        channel: process.env.SLACK_OPS_CHANNEL,
        text: 'HeyReach capacity check failed',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text:
                `:rotating_light: *HeyReach capacity check failed* — no warning was posted for:\n` +
                failures.map((f) => `• *${f.client}* — \`${f.error}\``).join('\n'),
            },
          },
        ],
      });
    } catch (err) {
      console.error('[capacity-check] ops notification failed:', err);
    }
  }

  res.status(failures.length > 0 ? 502 : 200).json({ ok: failures.length === 0, at: now.toISOString(), results });
};
