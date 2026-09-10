'use strict';

const { followUpClients } = require('../../lib/clients');
const { getWinnableThreads } = require('../../lib/inbox');
const { findDue, anchorInstant } = require('../../lib/followup');
const { buildFollowUpMessage } = require('../../lib/followup-message');
const { postMessage } = require('../../lib/slack');

/**
 * Daily follow-up reminders on winnable replies.
 *
 * Reads the threads a human tagged `Winnable` in the HeyReach inbox, works out which of
 * them crossed a follow-up step in the last day, and posts one Slack message per lead into
 * the channel the senders sit in, pinging the sender who owns the thread.
 *
 * Nothing is stored between runs. See lib/followup.js for why that is sound rather than
 * merely convenient: a step is crossed exactly once, and a thread self-clears the instant
 * its sender messages the lead.
 *
 * Query params, all for manual use:
 *   ?dryRun=1    build the payloads and return them without posting
 *   ?backfill=1  report every thread currently overdue, ignoring goLiveAt and the one-day
 *                window. This is the deliberate way to work the existing backlog; it will
 *                re-report leads that were already reminded about, so pair it with dryRun
 *                first and expect volume.
 *   ?client=     restrict to one client key
 *   ?limit=      cap the number of posts (default 25; guards against a backfill flood)
 *
 * SLACK_OVERRIDE_CHANNEL redirects every client's reminders to one destination -- a channel
 * id, or a user id to route them as DMs. Use it to watch a day of real output before the
 * senders see any of it.
 */
module.exports = async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return res.status(500).json({ ok: false, error: 'CRON_SECRET is not set; refusing to run' });
  }
  const presented =
    req.headers.authorization ??
    (req.headers['x-cron-secret'] ? `Bearer ${req.headers['x-cron-secret']}` : '');
  if (presented !== `Bearer ${secret}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const q = req.query ?? {};
  const dryRun = q.dryRun === '1' || q.dryRun === 'true';
  const backfill = q.backfill === '1' || q.backfill === 'true';
  const limit = Number.isFinite(Number(q.limit)) && Number(q.limit) > 0 ? Number(q.limit) : 25;
  const token = process.env.SLACK_BOT_TOKEN;
  const override = process.env.SLACK_OVERRIDE_CHANNEL || null;
  const now = Date.now();

  let clients = followUpClients();
  if (q.client) clients = clients.filter((c) => c.key === q.client);
  if (clients.length === 0) {
    return res.status(500).json({ ok: false, error: 'no clients have the follow-up tracker enabled' });
  }
  if (!token && !dryRun) {
    return res.status(500).json({ ok: false, error: 'SLACK_BOT_TOKEN is not set' });
  }

  const results = [];
  for (const client of clients) {
    try {
      const { threads, missingTags, storeError, storeConfigured } = await getWinnableThreads(client);
      const goLiveAt = Date.parse(client.followUp.goLiveAt ?? '') || 0;
      // Judged as of a fixed daily instant, not `now` -- see lib/followup.js.
      const evalAt = anchorInstant(now, client.followUp.evalHourUtc);
      const due = findDue(threads, { steps: client.followUp.steps, goLiveAt, evalAt, backfill });
      const posting = due.slice(0, limit);

      // The tag has not been created in this workspace yet, so there is nothing to read
      // rather than something broken. Say so loudly in the response -- a tracker that
      // reports nothing looks exactly like a quiet week.
      if (missingTags) {
        results.push({
          client: client.key,
          evaluatedAt: new Date(evalAt).toISOString(),
          posted: 0,
          configWarning: `tag(s) not present in this HeyReach workspace: ${missingTags.join(', ')}. ` +
            'Create the tag and apply it to winnable replies during inbox triage; ' +
            'nothing will be reported until then.',
        });
        continue;
      }

      const summary = {
        client: client.key,
        evaluatedAt: new Date(evalAt).toISOString(),
        destination: override ? `${override} (override)` : client.followUp.channelName,
        winnableThreads: threads.length,
        // Surfaced so a silently-degraded store is visible in the run output: without it,
        // "addressed leads never come back" looks identical to "nobody has replied".
        addressedStore: storeError ? `error: ${storeError}` : storeConfigured ? 'ok' : 'not configured',
        due: due.length,
        truncated: due.length > posting.length ? due.length - posting.length : 0,
        leads: posting.map((d) => ({
          name: d.thread.leadName,
          company: d.thread.company,
          sender: d.thread.senderName,
          step: d.step.label,
          idleDays: d.idleDays,
          weOweReply: d.weOweReply,
        })),
      };

      if (posting.length === 0) {
        results.push({ ...summary, posted: 0, reason: 'nothing crossed a step today' });
        continue;
      }

      const messages = posting.map((item) => buildFollowUpMessage({ client, item }));
      if (dryRun) {
        results.push({ ...summary, posted: 0, dryRun: true, messages });
        continue;
      }

      // One message per lead, sent in series. chat.postMessage is rate limited at roughly
      // one per second per channel, and a burst would be dropped rather than queued, so a
      // backfill of 25 takes ~30s of the 60s budget rather than racing.
      const channel = override ?? client.followUp.channel;
      let posted = 0;
      const failed = [];
      for (const message of messages) {
        try {
          await postMessage({ token, channel, ...message });
          posted += 1;
        } catch (err) {
          failed.push({ text: message.text, error: err.message });
        }
        await new Promise((r) => setTimeout(r, 1200));
      }
      results.push({ ...summary, posted, failed: failed.length ? failed : undefined, channel });
    } catch (err) {
      console.error(`[followup-check] ${client.key} failed:`, err);
      results.push({ client: client.key, error: err.message });
    }
  }

  // A silent failure is the dangerous one here too: no reminder is indistinguishable from
  // a quiet day, and a quiet day is the normal case.
  const failures = results.filter((r) => r.error);
  const warnings = results.filter((r) => r.configWarning);

  // Nag about a misconfiguration once a week rather than every morning. Which day it is
  // comes from the evaluation instant, so this needs no memory of previous runs either.
  const isMonday = new Date(anchorInstant(now, 14)).getUTCDay() === 1;
  if (warnings.length > 0 && isMonday && token && !dryRun && process.env.SLACK_OPS_CHANNEL) {
    try {
      await postMessage({
        token,
        channel: process.env.SLACK_OPS_CHANNEL,
        text: 'Follow-up tracker is not reading anything',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text:
                ':warning: *Follow-up tracker has nothing to read* — weekly reminder:\n' +
                warnings.map((w) => `• *${w.client}* — ${w.configWarning}`).join('\n'),
            },
          },
        ],
      });
    } catch (err) {
      console.error('[followup-check] config warning notification failed:', err);
    }
  }
  if (failures.length > 0 && token && !dryRun && process.env.SLACK_OPS_CHANNEL) {
    try {
      await postMessage({
        token,
        channel: process.env.SLACK_OPS_CHANNEL,
        text: 'Follow-up tracker failed',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text:
                ':rotating_light: *Follow-up tracker failed* — no reminders were posted for:\n' +
                failures.map((f) => `• *${f.client}* — \`${f.error}\``).join('\n'),
            },
          },
        ],
      });
    } catch (err) {
      console.error('[followup-check] ops notification failed:', err);
    }
  }

  res
    .status(failures.length > 0 ? 502 : 200)
    .json({ ok: failures.length === 0, at: new Date(now).toISOString(), backfill, results });
};
