'use strict';

const { getSenders, getActiveCampaigns, getQueuedBySender, getSentToday, mapLimit } = require('./heyreach');

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

  const [allSenders, campaigns] = await Promise.all([getSenders(apiKey), getActiveCampaigns(apiKey)]);

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

  // A sender is in scope if it is switched on, regardless of whether it currently holds leads —
  // a sender with zero queued leads is precisely the case we must catch.
  const inScope = allSenders.filter((s) => s.isActive);
  const sentTodayList = await mapLimit(inScope, CONCURRENCY, (s) => getSentToday(apiKey, s.id));

  const senders = inScope.map((s, i) => {
    const sentToday = sentTodayList[i];
    const queued = queuedBySender.get(s.id) ?? 0;
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
