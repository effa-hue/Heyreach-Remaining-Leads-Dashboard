'use strict';

const { hrPost, PAGE_SIZE } = require('./heyreach');

/**
 * Inbox threads for the follow-up tracker.
 *
 * The "is this worth chasing" decision is NOT made here. It is the `Winnable` tag that the
 * team already applies by hand during inbox triage -- the same signal Advance runs on today
 * (41 leads tagged there). Reading a human tag rather than re-grading the reply text keeps
 * the tracker and the inbox in agreement: if a rep untags a lead, it stops nagging.
 *
 * `filters.tags` is matched server-side and exactly -- asking for ["Winnable"] returns
 * precisely the 41. Watch the field name: the plausible-looking `leadTags` is accepted with
 * a 200 and then silently ignored, returning the entire inbox. That failure looks like
 * "every conversation is winnable" rather than like an error, so it is worth asserting on.
 */
async function getTaggedConversations(apiKey, tags) {
  const items = [];
  let offset = 0;
  let total = null;
  while (total === null || offset < total) {
    let page;
    try {
      page = await hrPost(apiKey, '/inbox/GetConversationsV2', {
        filters: { tags },
        offset,
        limit: PAGE_SIZE,
      });
    } catch (err) {
      const missing = missingTagsFrom(err);
      if (missing) return { items: [], missingTags: missing };
      throw err;
    }
    if (total === null) {
      total = page.totalCount ?? 0;
      if (total === 0) break;
    }
    const batch = page.items ?? [];
    if (batch.length === 0) break;
    items.push(...batch);
    offset += PAGE_SIZE;
  }
  return { items, missingTags: null };
}

/**
 * Asking for a tag that does not exist in the workspace is a 400, not an empty result.
 *
 *   {"errorMessage":"Cannot filter with Tags because the following tags do not exist: Winnable"}
 *
 * That matters on day one: MakersHub's inbox has only `Responded` on it, so until someone
 * creates and applies `Winnable` this query fails outright. Left unhandled the cron would
 * 502 and fire the ops alarm every single morning, which trains everyone to ignore it.
 * Treated as "no winnable leads yet, and here is why" instead.
 */
function missingTagsFrom(err) {
  const m = /tags do not exist:\s*([^"}]+)/i.exec(err?.message ?? '');
  return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : null;
}

/** HeyReach stamps fractional seconds at whatever precision it feels like ("...:22.02Z"). */
function parseTs(s) {
  const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
}

/**
 * Flatten one conversation into the facts the tracker reasons about.
 *
 * The clock is `lastMessageAt` -- the newest message in either direction, not the newest
 * inbound. That is what makes the reminder self-clearing with no datastore behind it: the
 * moment a sender messages the lead, the thread's idle age resets to zero and it drops off
 * the list on its own. There is nothing for a rep to tick off and nothing to fall out of
 * sync with the inbox.
 *
 * `messages` has been verified complete rather than truncated (totalMessages equals the
 * array length on all 354 Advance and 1,194 MakersHub conversations, longest thread 22), so
 * the last inbound can be read straight off it without a second fetch.
 */
function toThread(conv) {
  const msgs = (conv.messages ?? [])
    .map((m) => ({ ...m, at: parseTs(m.createdAt) }))
    .filter((m) => m.at !== null)
    .sort((a, b) => a.at - b.at);
  if (msgs.length === 0) return null;

  const cp = conv.correspondentProfile ?? {};
  const acct = conv.linkedInAccount ?? {};
  const inbound = msgs.filter((m) => m.sender !== 'ME');
  // A Winnable lead with no inbound message would mean the tag was applied to someone who
  // never actually replied. None exist today; skip rather than nag about a phantom reply.
  if (inbound.length === 0) return null;

  const last = msgs[msgs.length - 1];
  const lastInbound = inbound[inbound.length - 1];
  const autoTags = cp.autoTags ?? [];

  return {
    conversationId: conv.id,
    leadName: `${cp.firstName ?? ''} ${cp.lastName ?? ''}`.trim().replace(/\s+/g, ' '),
    leadFirstName: (cp.firstName ?? '').trim(),
    company: (cp.companyName ?? '').trim() || null,
    position: (cp.position ?? cp.headline ?? '').trim() || null,
    profileUrl: cp.profileUrl ?? null,
    linkedinId: cp.linkedin_id ?? null,
    tags: cp.tags ?? [],
    // autoTags carry HeyReach's own sentiment label AND the campaign that produced the
    // reply, so a thread pulled by tag can still name its campaign without a second query.
    // (`filters.campaignIds` does work on this endpoint, but it 400s on an id that is not
    // in the same workspace as the key -- which reads like the filter being unsupported
    // rather than like a mismatched id.)
    campaign: autoTags.find((t) => t?.campaignName)?.campaignName ?? null,
    sentiment: autoTags.find((t) => t?.name)?.name ?? null,
    senderAccountId: acct.id ?? conv.linkedInAccountId ?? null,
    senderName: `${acct.firstName ?? ''} ${acct.lastName ?? ''}`.trim().replace(/\s+/g, ' ') || null,
    lastMessageAt: last.at,
    lastMessageFromUs: last.sender === 'ME',
    lastInboundAt: lastInbound.at,
    lastInboundText: (lastInbound.body ?? '').trim(),
    totalMessages: msgs.length,
  };
}

/** Winnable threads for one client, normalised, newest activity first. */
async function getWinnableThreads(client) {
  const { items, missingTags } = await getTaggedConversations(
    client.apiKey,
    client.followUp.winnableTags
  );
  const threads = items
    .map(toThread)
    .filter(Boolean)
    .filter((t) => !t.tags.some((tag) => client.followUp.excludeTags.includes(tag)))
    .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  return { threads, missingTags };
}

module.exports = { getTaggedConversations, getWinnableThreads, toThread, parseTs, missingTagsFrom };
