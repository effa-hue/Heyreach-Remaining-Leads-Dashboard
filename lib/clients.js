'use strict';

/**
 * Client registry for the send-capacity agent.
 *
 * `window` is the LinkedIn sending window HeyReach is configured with, expressed in
 * `timeZone`. HeyReach's public API does NOT expose campaign schedules (probed
 * campaign/GetById, campaign/GetCampaignSchedule, campaign/GetWorkingHours,
 * li_account/GetSchedule — only the sequence tree comes back), so it has to live here.
 *
 * The values below are the *observed* windows, derived from the hour histogram of
 * `lastActionTime` on leads that reached ConnectionSent/Connected over a 21-day lookback.
 * Both workspaces agree on 10:00-20:00 America/New_York with zero activity outside it
 * (n=953 Advance, n=1588 MakersHub) — which is 08:00-18:00 Mountain, i.e. the schedule is
 * almost certainly set in Mountain time rather than Eastern. Re-derive any time with
 * `node scripts/dry-run.js --window`.
 */
const CLIENTS = [
  {
    key: 'advance',
    label: 'Advance',
    slackChannel: 'C0BKN29JN9W',
    slackChannelName: '#advance',
    apiKeyEnv: 'HEYREACH_KEY_ADVANCE',
    timeZone: 'America/New_York',
    window: { start: '10:00', end: '20:00' },
    sendDays: [1, 2, 3, 4, 5], // Mon-Fri; campaigns are switched off end of day Friday
  },
  {
    key: 'makershub',
    label: 'MakersHub',
    slackChannel: 'C0BH2GBG0NM',
    slackChannelName: '#makershub',
    apiKeyEnv: 'HEYREACH_KEY_MAKERSHUB',
    timeZone: 'America/New_York',
    window: { start: '10:00', end: '20:00' },
    sendDays: [1, 2, 3, 4, 5],
  },
];

/** Clients that have their HeyReach key present in the environment. */
function configuredClients(env = process.env) {
  return CLIENTS.map((c) => ({ ...c, apiKey: env[c.apiKeyEnv] })).filter((c) => !!c.apiKey);
}

module.exports = { CLIENTS, configuredClients };
