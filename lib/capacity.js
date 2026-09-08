'use strict';

const {
  getSenders,
  getActiveCampaigns,
  getQueuedBySender,
  getSentToday,
  getSequence,
  sendsConnectionRequests,
  mapLimit,
} = require('./heyreach');

/** How many HeyReach calls to keep in flight. Enough to stay well inside maxDuration. */
const CONCURRENCY = 6;

/**
 * Today's connection-request capacity for one client, per sender.
 *
 *   remainingCapacity = dailyLimit - sentToday      (CRs the sender could still send today)
 *   shortfall         = remainingCapacity - queued  (leads that must be added to fill it)
 *
 * A sender with shortfall > 0 will end the day under its connection limit purely for want
 * of leads, which is the thing worth waking someone up for. Senders that are blocked for a
 * different reason (bad auth, LinkedIn cooldown, inactive) are reported separately, because
 * re-upping leads will not fix those.
 */
async function assessClient(client) {
  const { apiKey } = client;

  const [allSenders, activeCampaigns] = await Promise.all([getSenders(apiKey), getActiveCampaigns(apiKey)]);

  // Only campaigns that open with a connection request can consume the daily CR budget.
  // First-degree campaigns message existing connections and would otherwise contribute
  // phantom inventory, hiding real shortfalls. Read the sequence rather than matching on the
  // campaign name — names are not a reliable signal.
  const shapes = await mapLimit(activeCampaigns, CONCURRENCY, async (campaign) => {
    try {
      return { campaign, sendsCr: sendsConnectionRequests(await getSequence(apiKey, campaign.id)) };
    } catch (err) {
      // Unreadable sequence: keep the campaign in. Over-counting inventory is the softer
      // failure -- it quietens an alert, where excluding a real CR campaign would invent one.
      console.warn(`[capacity] ${client.key}: sequence unreadable for ${campaign.id}, counting it anyway:`, err.message);
      return { campaign, sendsCr: true };
    }
  });

  const campaigns = shapes.filter((s) => s.sendsCr).map((s) => s.campaign);
  const excluded = shapes.filter((s) => !s.sendsCr).map((s) => s.campaign);

  // Queued inventory per campaign, then folded per sender.
  const perCampaign = await mapLimit(campaigns, CONCURRENCY, async (campaign) => ({
    campaign,
    bySender: await getQueuedBySender(apiKey, campaign.id),
  }));

  const queuedBySender = new Map();
  const campaignsBySender = new Map();
  for (const { campaign, bySender } of perCampaign) {
    for (const [senderId, count] of bySender) {
      queuedBySender.set(senderId, (queuedBySender.get(senderId) ?? 0) + count);
      if (!campaignsBySender.has(senderId)) campaignsBySender.set(senderId, []);
      campaignsBySender.get(senderId).push({ id: campaign.id, name: campaign.name, queued: count });
    }
  }

  // Freshly re-upped leads sit in progressStats.totalUsersPending and are not listed per-lead,
  // so they carry no sender. HeyReach hands them out round-robin across the campaign's
  // accounts, so credit each account an even share. This is an ESTIMATE and is reported as
  // one: the split is assumed even, and some pending leads will later be excluded as
  // duplicates. Floored deliberately -- understating inventory risks a needless nudge, while
  // overstating it would suppress a real warning.
  const pendingShareBySender = new Map();
  let pendingTotal = 0;
  for (const campaign of campaigns) {
    if (!campaign.pending || !campaign.accountIds.length) continue;
    pendingTotal += campaign.pending;
    const share = campaign.pending / campaign.accountIds.length;
    for (const accountId of campaign.accountIds) {
      pendingShareBySender.set(accountId, (pendingShareBySender.get(accountId) ?? 0) + share);
    }
  }

  // A sender is in scope if it is switched on, regardless of whether it currently holds leads —
  // a sender with zero queued leads is precisely the case we must catch.
  const inScope = allSenders.filter((s) => s.isActive);
  const sentTodayList = await mapLimit(inScope, CONCURRENCY, (s) => getSentToday(apiKey, s.id));

  const senders = inScope.map((s, i) => {
    const sentToday = sentTodayList[i];
    const assignedQueued = queuedBySender.get(s.id) ?? 0;
    const pendingShare = Math.floor(pendingShareBySender.get(s.id) ?? 0);
    const queued = assignedQueued + pendingShare;
    const remainingCapacity = Math.max(0, s.dailyLimit - sentToday);
    const shortfall = Math.max(0, remainingCapacity - queued);
    const blockedReason = !s.authIsValid
      ? 'LinkedIn auth invalid'
      : s.connectionRequestCooldown
        ? 'connection-request cooldown'
        : s.activeCampaigns === 0
          ? 'not in any active campaign'
          : null;
    return {
      ...s,
      sentToday,
      queued,
      assignedQueued,
      pendingShare,
      remainingCapacity,
      shortfall,
      blockedReason,
      campaigns: (campaignsBySender.get(s.id) ?? []).sort((a, b) => a.queued - b.queued),
    };
  });

  const atRisk = senders.filter((s) => s.shortfall > 0 && !s.blockedReason);
  const blocked = senders.filter((s) => s.blockedReason);
  const sum = (list, field) => list.reduce((t, s) => t + s[field], 0);

  return {
    client,
    campaigns,
    excluded,
    pendingTotal,
    senders,
    atRisk,
    blocked,
    totals: {
      dailyLimit: sum(senders, 'dailyLimit'),
      sentToday: sum(senders, 'sentToday'),
      queued: sum(senders, 'queued'),
      // Summed over at-risk senders only, not every sender: the message reads "re-up N leads
      // across M senders", so N has to be the shortfall those M senders actually account for.
      // A blocked sender can carry a shortfall too, but re-upping leads would not fix it.
      shortfall: sum(atRisk, 'shortfall'),
    },
  };
}

module.exports = { assessClient, CONCURRENCY };
