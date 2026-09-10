'use strict';

const section = (text) => ({ type: 'section', text: { type: 'mrkdwn', text } });
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

module.exports = { buildFollowUpMessage, esc, quote };
