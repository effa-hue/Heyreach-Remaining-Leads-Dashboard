'use strict';

const { humanDuration } = require('./window');

const fmt = (n) => n.toLocaleString('en-US');
const padR = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

/** Worst first, so the senders that need leads sit at the top of the table. */
const byUrgency = (a, b) => (b.shortfall ?? 0) - (a.shortfall ?? 0) || a.name.localeCompare(b.name);

/**
 * Every sender's standing, as a monospace table.
 *
 * Kept to ~41 columns so it does not wrap in Slack on a phone. The at-risk senders are also
 * called out as bullets above with their thinnest campaign — this is the surrounding context,
 * i.e. who is fine and who is blocked.
 */
function senderTable(senders) {
  const rows = [
    `${padR('Sender', 16)}${padL('Lim', 5)}${padL('Sent', 6)}${padL('Queue', 7)}${padL('Re-up', 7)}`,
  ];
  for (const s of [...senders].sort(byUrgency)) {
    const reup = s.blockedReason ? 'blkd' : s.shortfall > 0 ? String(s.shortfall) : '-';
    rows.push(
      `${padR(s.name.slice(0, 15), 16)}${padL(s.dailyLimit, 5)}${padL(s.sentToday, 6)}${padL(s.queued, 7)}${padL(reup, 7)}`
    );
  }
  return '```\n' + rows.join('\n') + '\n```';
}

/**
 * Build the Slack message for one client's assessment, or null when there is nothing to say.
 *
 * Deliberately short: a headline carrying the one number that needs acting on, a single line
 * of context, then one line per sender saying where to put the leads. The full per-sender
 * breakdown belongs in the dashboard, not in a channel post.
 *
 * `run` is 'preflight' (before the window opens) or 'midday'. It only changes the framing —
 * the numbers are computed identically, and the urgency reads off the real elapsed fraction
 * rather than which cron fired, so a late Hobby-plan invocation is still accurate.
 */
function buildMessage({ assessment, state, run, postAllClear = false }) {
  const { client, senders, atRisk, blocked, totals, campaigns, excluded = [] } = assessment;
  const label = client.label;
  const tz = tzAbbrev(client, state);

  if (atRisk.length === 0 && blocked.length === 0) {
    if (!postAllClear) return null;
    return {
      text: `${label}: quota covered, nothing to re-up.`,
      blocks: [
        section(
          `🟢 *${label} — quota covered*\n` +
            `Sent *${totals.sentToday}/${totals.dailyLimit}* today · ${fmt(totals.queued)} leads queued · nothing to re-up`
        ),
        section(senderTable(senders)),
      ],
    };
  }

  const short = totals.shortfall;
  const deadline = state.beforeWindow ? ` before ${state.startLabel} ${tz}` : '';
  const headline =
    atRisk.length === 0
      ? `🟡 *${label} — ${blocked.length} sender${blocked.length === 1 ? '' : 's'} blocked*`
      : `🔴 *${label} — re-up ${fmt(short)} lead${short === 1 ? '' : 's'}${deadline}*`;

  // Deliberately no aggregate "N queued" figure. Total queued routinely exceeds the total
  // quota while individual senders sit empty — the shortfall is a distribution problem, so an
  // aggregate reads as reassuring exactly when it should not. Count the affected senders instead.
  const shortOf =
    atRisk.length > 0 ? ` · *${atRisk.length} of ${senders.length}* senders out of leads` : '';
  const context =
    run === 'preflight' && state.beforeWindow
      ? `Opens in ${humanDuration(state.minutesToStart)} · ${totals.dailyLimit} connection requests planned today${shortOf}`
      : `${timing(state)} · *${totals.sentToday} of ${totals.dailyLimit}* sent${shortOf}`;

  const blocks = [section(`${headline}\n${context}`)];

  if (atRisk.length > 0) {
    blocks.push(
      section([...atRisk].sort(byUrgency).map((sender) => senderLine(sender, campaigns.length)).join('\n'))
    );
  }

  blocks.push(section(senderTable(senders)));

  if (blocked.length > 0) {
    blocks.push(
      context_(
        `🟡 Blocked — leads won't help: ` +
          blocked.map((s) => `*${s.name}* (${s.blockedReason})`).join(', ')
      )
    );
  }

  const footer = [];
  if (excluded.length) {
    footer.push(`${excluded.length} campaign${excluded.length === 1 ? '' : 's'} not counted (no connection-request step)`);
  }
  if (process.env.DASHBOARD_URL) footer.push(`<${process.env.DASHBOARD_URL}|Open the dashboard>`);
  if (footer.length) blocks.push(context_(footer.join(' · ')));

  return {
    text:
      atRisk.length > 0
        ? `${label}: re-up ${short} lead${short === 1 ? '' : 's'} or today's connection limit is missed.`
        : `${label}: ${blocked.length} sender(s) blocked.`,
    blocks,
  };
}

/**
 * How the run sits in the window.
 *
 * humanDuration is unsigned, so a closed window has to be phrased separately — otherwise a
 * run after 8PM reads "2h 8m left, 100% through", which is self-contradictory. Only reachable
 * via ?force=1, since the handler normally skips once the window has closed.
 */
function timing(state) {
  if (state.minutesToEnd > 0) return `${humanDuration(state.minutesToEnd)} left, ${state.elapsedPct}% through`;
  return `window closed ${humanDuration(state.minutesToEnd)} ago`;
}

/**
 * "• *Sam Grasso* — *23* short · nothing queued across 12 connection-request campaigns"
 *
 * `crCount` is the number of campaigns that actually send connection requests, not the
 * sender's `activeCampaigns` from HeyReach — that figure includes first-degree campaigns,
 * which are excluded from this whole calculation and would make the line contradict itself.
 */
function senderLine(s, crCount) {
  const where =
    s.campaigns.length === 0
      ? `nothing queued across ${crCount} connection-request campaign${crCount === 1 ? '' : 's'}`
      : `${fmt(s.queued)} queued, thinnest ${s.campaigns[0].name} \`#${s.campaigns[0].id}\` (${s.campaigns[0].queued})`;
  return `• *${s.name}* — *${s.shortfall}* short · ${where}`;
}

/** Short timezone label ("ET", "PT") for the client's zone on this date. */
function tzAbbrev(client, state) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: client.timeZone,
      timeZoneName: 'short',
    }).formatToParts(new Date());
    const name = parts.find((p) => p.type === 'timeZoneName')?.value;
    // Collapse EDT/EST -> ET so the label does not churn twice a year.
    return name ? name.replace(/^(\w)(?:D|S)T$/, '$1T') : client.timeZone;
  } catch {
    return client.timeZone;
  }
}

const section = (text) => ({ type: 'section', text: { type: 'mrkdwn', text } });
const context_ = (text) => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });

module.exports = { buildMessage, senderLine, tzAbbrev };
