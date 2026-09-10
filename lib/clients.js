'use strict';

/**
 * Client registry for the send-capacity agent and the follow-up tracker.
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
 *
 * `followUp` drives the winnable-reply follow-up tracker (api/cron/followup-check.js).
 * `senders` maps a HeyReach LinkedIn account id to the Slack user to ping. It is keyed by
 * account id rather than by name on purpose: HeyReach calls him "Charles Howe" and Slack
 * calls him "Charley Howe", and a name-matched map would silently drop his reminders.
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
    followUp: {
      // Off until Advance has somewhere to post. Its senders (Morgan Blocher, Hadas Ashur,
      // Edgar Lewis, Omer Rimoch, Nicole Cruse, Gal Dreiman) are not in #advance, which has
      // only the Kadima side in it, and there is no #kadima-advance-responses equivalent.
      // To switch on: create that channel, invite the senders, fill `senders` below with
      // their Slack ids, set the channel, and flip `enabled`. Nothing else changes —
      // Advance already tags `Winnable` in HeyReach (41 leads today), which is the signal
      // this whole tracker reads.
      enabled: false,
      channel: null,
      channelName: null,
      winnableTags: ['Winnable'],
      excludeTags: ['Not interested', 'Disqualified on facts'],
      // Written to the lead when a sender presses Addressed, and handled separately from
      // `excludeTags` rather than listed in it: a hard exclude would drop the lead before
      // the tracker could notice they have replied since. Must exist in the HeyReach
      // workspace. See lib/inbox.js `isRevived`.
      addressedTag: 'Addressed',
      steps: [
        { days: 7, label: '1 week' },
        { days: 11, label: '1.5 weeks' },
      ],
      // The hour the run judges itself as of, and the hour vercel.json schedules it for.
      // Must stay in step with the cron: it is what makes consecutive runs exactly 24h
      // apart despite Hobby-plan firing jitter. 14:00 UTC is 10:00 ET, as the window opens.
      evalHourUtc: 14,
      goLiveAt: null,
      senders: {},
    },
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
    followUp: {
      enabled: true,
      // Not #makershub — that is the Kadima-internal channel (Yael and Effa only). The
      // reminders have to land where the six senders actually are, which is the same
      // channel HeyReach already posts "New Reply:" notifications into.
      channel: 'C0BMB34K2VD',
      channelName: '#kadima-makershub-responses',
      winnableTags: ['Winnable'],
      // Verified non-overlapping in Advance's inbox: no lead carries `Winnable` alongside
      // either of these. Listed so that tagging a lead dead is enough to stop the chase.
      excludeTags: ['Not interested', 'Disqualified on facts'],
      // Written to the lead when a sender presses Addressed, and handled separately from
      // `excludeTags` rather than listed in it: a hard exclude would drop the lead before
      // the tracker could notice they have replied since. Must exist in the HeyReach
      // workspace. See lib/inbox.js `isRevived`.
      addressedTag: 'Addressed',
      steps: [
        { days: 7, label: '1 week' },
        { days: 11, label: '1.5 weeks' },
      ],
      // The hour the run judges itself as of, and the hour vercel.json schedules it for.
      // Must stay in step with the cron: it is what makes consecutive runs exactly 24h
      // apart despite Hobby-plan firing jitter. 14:00 UTC is 10:00 ET, as the window opens.
      evalHourUtc: 14,
      // Crossings before this instant are not replayed — see lib/followup.js. Set to the
      // deploy date so the 60 threads already idle past a week stay out of the channel.
      goLiveAt: '2026-09-11T00:00:00.000Z',
      senders: {
        227672: { name: 'Sam Grasso', slackUserId: 'U087F3EA1D0' },
        228534: { name: 'Charles Howe', slackUserId: 'U064CLEHZEZ' },
        228829: { name: 'Wesley Bauer', slackUserId: 'U08LV8JN97X' },
        228966: { name: 'Sonny Singh', slackUserId: 'U09BR825HDJ' },
        230914: { name: 'Robert Scott', slackUserId: 'U094JF03PNJ' },
        233402: { name: 'Phong Ngo', slackUserId: 'U06412970DV' },
      },
    },
  },
];

/** Clients that have their HeyReach key present in the environment. */
function configuredClients(env = process.env) {
  return CLIENTS.map((c) => ({ ...c, apiKey: env[c.apiKeyEnv] })).filter((c) => !!c.apiKey);
}

/** Clients wired up for the follow-up tracker: key present, tracker on, channel set. */
function followUpClients(env = process.env) {
  return configuredClients(env).filter((c) => c.followUp?.enabled && c.followUp.channel);
}

module.exports = { CLIENTS, configuredClients, followUpClients };
