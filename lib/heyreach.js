'use strict';

const BASE = 'https://api.heyreach.io/api/public';

/** HeyReach rejects any page size above 100 with a 400. */
const PAGE_SIZE = 100;

/** Both HeyReach and Instantly reject requests without a User-Agent. */
const UA = 'kadima-capacity-agent/1.0';

async function hrPost(apiKey, path, body = {}, { retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify(body),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw Object.assign(new Error(`HTTP ${res.status} on ${path}${txt ? ` -> ${txt.slice(0, 200)}` : ''}`), {
          fatal: true,
        });
      }
      return res.json();
    } catch (err) {
      lastErr = err;
      if (err.fatal || attempt === retries) break;
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
    }
  }
  throw lastErr;
}

/** Run `worker` over `items` with at most `limit` in flight. */
async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        out[i] = await worker(items[i], i);
      }
    })
  );
  return out;
}

/**
 * LinkedIn sender accounts, with the per-day connection-request ceiling.
 *
 * NB `connectioRequestLimit` is HeyReach's own spelling — the 'n' really is missing.
 * It is the current (ramped) daily limit; `connectioRequestMax` is the ceiling it ramps to.
 */
async function getSenders(apiKey) {
  const json = await hrPost(apiKey, '/li_account/GetAll', { offset: 0, limit: PAGE_SIZE });
  return (json.items ?? []).map((a) => {
    const limits = a.accountLimits ?? {};
    return {
      id: a.id,
      name: `${a.firstName ?? ''} ${a.lastName ?? ''}`.trim().replace(/\s+/g, ' ') || `#${a.id}`,
      isActive: a.isActive === true,
      authIsValid: a.authIsValid === true,
      activeCampaigns: a.activeCampaigns ?? 0,
      connectionRequestCooldown: a.connectionRequestCooldown === true,
      dailyLimit: limits.connectioRequestLimit ?? 0,
      dailyLimitMax: limits.connectioRequestMax ?? 0,
    };
  });
}

async function getActiveCampaigns(apiKey) {
  const json = await hrPost(apiKey, '/campaign/GetAll', { offset: 0, limit: PAGE_SIZE });
  return (json.items ?? [])
    .filter((c) => c.status === 'IN_PROGRESS')
    .map((c) => ({ id: c.id, name: c.name, accountIds: c.campaignAccountIds ?? [] }));
}

/**
 * Leads in a campaign that are still waiting on a connection request, counted per sender.
 *
 * Two buckets, matching the dashboard's "Pending" + "Conn. Check" columns:
 *   - Pending                              -> queued, sequence not started
 *   - InSequence + connection status None  -> sitting at the CHECK_IS_CONNECTION gate,
 *                                             i.e. the next action for this lead is the CR
 */
async function getQueuedBySender(apiKey, campaignId) {
  const bySender = new Map();
  let offset = 0;
  let total = null;
  while (total === null || offset < total) {
    const page = await hrPost(apiKey, '/campaign/GetLeadsFromCampaign', {
      campaignId,
      offset,
      limit: PAGE_SIZE,
    });
    if (total === null) {
      total = page.totalCount ?? 0;
      if (total === 0) break;
    }
    for (const lead of page.items ?? []) {
      const status = lead.leadCampaignStatus;
      const conn = lead.leadConnectionStatus;
      const awaitingCr = status === 'Pending' || (status === 'InSequence' && conn === 'None');
      if (!awaitingCr) continue;
      const sid = lead.linkedInSenderId;
      if (sid == null) continue;
      bySender.set(sid, (bySender.get(sid) ?? 0) + 1);
    }
    offset += PAGE_SIZE;
  }
  return bySender;
}

/**
 * Connection requests a sender has already sent today.
 *
 * Uses the UTC calendar day, because `byDayStats` is keyed by UTC day and has no finer
 * granularity — an ET business day that straddles UTC midnight simply cannot be isolated
 * through this endpoint.
 *
 * That is sound at the times the crons actually fire. The window is 10:00-20:00 ET, i.e.
 * 14:00-24:00 UTC in summer and 15:00-01:00 UTC in winter, and both crons land mid-window
 * (13:00 and 18:00 UTC), so UTC day and ET business day agree whenever this is read for real.
 * They do diverge after 20:00 ET, where the UTC day has already rolled over and this returns
 * ~0 — visible only via ?force=1 outside the window, which inflates the apparent shortfall.
 *
 * Omitting the dates entirely returns all history, not today, so they are always sent.
 */
async function getSentToday(apiKey, senderId, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const json = await hrPost(apiKey, '/stats/GetOverallStats', {
    accountIds: [senderId],
    campaignIds: [],
    startDate: `${day}T00:00:00.000Z`,
    endDate: `${day}T23:59:59.999Z`,
  });
  return Object.values(json.byDayStats ?? {}).reduce((sum, d) => sum + (d.connectionsSent ?? 0), 0);
}

module.exports = { hrPost, mapLimit, getSenders, getActiveCampaigns, getQueuedBySender, getSentToday, PAGE_SIZE };
