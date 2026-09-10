'use strict';

const section = (text) => ({ type: 'section', text: { type: 'mrkdwn', text } });

/** action_id the interactivity endpoint routes on. */
const ADDRESSED_ACTION = 'followup_addressed';

/**
 * Where "Open in HeyReach" points.
 *
 * HeyReach has no per-conversation deep link -- its route table defines `inbox` with no id
 * parameter and no conversation query param, so `/app/inbox` (the Unibox) is as precise as
 * a URL can get. The lead's name is passed as `searchTerm`, the param its list components
 * use, so the inbox is likely to open filtered to them; if it is ignored the button still
 * lands the sender in the right inbox, which is the point.
 */
function heyreachInboxUrl(client, thread) {
  const base = client.followUp.heyreachInboxUrl ?? 'https://app.heyreach.io/app/inbox';
  return thread.leadName ? `${base}?searchTerm=${encodeURIComponent(thread.leadName)}` : base;
}
const context_ = (text) => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });

/**
 * Slack mrkdwn is not HTML-escaped for us. A reply containing `<` or `&` -- and prospects
 * do paste email addresses in angle brackets -- would otherwise be swallowed as a broken
 * link and the quote would silently lose text.
 */
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Quote a reply, trimmed to something readable in a channel. */
function quote(body, limit = 500) {
  const clean = String(body ?? '').replace(/\r/g, '').trim();
  if (!clean) return null;
  const cut = clean.length > limit ? clean.slice(0, limit).replace(/\s+\S*$/, '') + '…' : clean;
  return cut.split('\n').map((line) => `> ${esc(line)}`).join('\n');
}

const dayLabel = (ms, timeZone) =>
  new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric' }).format(new Date(ms));

/**
 * One reminder, for one lead, addressed to the sender who owns the thread.
 *
 * Addressed is the operative word: the sender is a real `<@id>` mention rather than a name
 * in text, so the reminder reaches them in their activity feed instead of relying on
 * someone reading the channel. When the id is missing the name is bolded instead — the
 * reminder still posts, because a reminder nobody is pinged on beats no reminder at all.
 */
function buildFollowUpMessage({ client, item, timeZone = client.timeZone }) {
  const { thread, step, idleDays, weOweReply } = item;
  const sender = client.followUp.senders[thread.senderAccountId];
  const who = sender?.slackUserId ? `<@${sender.slackUserId}>` : `*${esc(thread.senderName ?? 'Unknown sender')}*`;

  const icon = weOweReply ? ':rotating_light:' : ':hourglass_flowing_sand:';
  const heading = weOweReply
    ? `${icon} *Unanswered reply — ${esc(step.label)}*`
    : `${icon} *Follow-up due — ${esc(step.label)}*`;

  const lead = thread.profileUrl
    ? `<${thread.profileUrl}|*${esc(thread.leadName)}*>`
    : `*${esc(thread.leadName)}*`;
  const role = [thread.position, thread.company].filter(Boolean).map(esc).join(' · ');

  const line = weOweReply
    ? `${who} — ${lead} replied *${idleDays} days ago* and we have not answered.`
    : `${who} — ${lead} has been quiet for *${idleDays} days* since your last message.`;

  const blocks = [section(`${heading}\n${line}${role ? `\n_${role}_` : ''}`)];

  const q = quote(thread.lastInboundText);
  if (q) blocks.push(section(`Their last reply (${dayLabel(thread.lastInboundAt, timeZone)}):\n${q}`));

  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        action_id: ADDRESSED_ACTION,
        text: { type: 'plain_text', text: 'Addressed', emoji: true },
        style: 'primary',
        // Everything the interactivity handler needs to tag the right lead in the right
        // workspace, carried in the payload rather than looked up -- there is no store to
        // look it up in. Slack caps this at 2000 chars; these run to ~150.
        value: JSON.stringify({
          c: client.key,
          li: thread.linkedinId,
          u: thread.profileUrl,
          n: thread.leadName,
          co: thread.company,
        }),
      },
      {
        type: 'button',
        action_id: 'followup_open_heyreach',
        text: { type: 'plain_text', text: 'Open in HeyReach', emoji: true },
        url: heyreachInboxUrl(client, thread),
      },
    ],
  });

  const footer = [
    thread.campaign ? `Campaign: ${esc(thread.campaign)}` : null,
    `Last activity ${dayLabel(thread.lastMessageAt, timeZone)}`,
    `${thread.totalMessages} message${thread.totalMessages === 1 ? '' : 's'}`,
    thread.sentiment ? `HeyReach: ${esc(thread.sentiment)}` : null,
  ].filter(Boolean);
  blocks.push(context_(footer.join(' · ')));

  return {
    // The fallback text is what shows in the notification and the sidebar, so it carries
    // the name and the age rather than just the word "reminder".
    text: `${weOweReply ? 'Unanswered reply' : 'Follow-up due'} (${step.label}): ${thread.leadName}${thread.company ? ` at ${thread.company}` : ''} — ${idleDays} days`,
    blocks,
  };
}

/**
 * What the reminder collapses to once someone presses Addressed.
 *
 * Deliberately one line. The reminder has done its job and the channel should read as a
 * list of what still needs attention, not a wall of settled business -- so the quote, the
 * buttons and the metadata all go, leaving who resolved it and when.
 */
function buildResolvedMessage({ leadName, company, userId, tagged, tagError }) {
  const where = company ? ` (${esc(company)})` : '';
  const note = tagError
    ? `  ·  _could not tag in HeyReach: ${esc(tagError)}_`
    : tagged
      ? ''
      : '';
  return {
    text: `Resolved: ${leadName}`,
    blocks: [
      section(`:white_check_mark: *Resolved* — ${esc(leadName)}${where}, addressed by <@${userId}>.${note}`),
    ],
  };
}

module.exports = {
  buildFollowUpMessage,
  buildResolvedMessage,
  heyreachInboxUrl,
  ADDRESSED_ACTION,
  esc,
  quote,
};
