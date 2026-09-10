'use strict';

/**
 * Self-test for the follow-up tracker's exactly-once property.
 *
 * The tracker keeps no record of what it has already said, so "each lead is reminded once
 * per step" is a claim about the arithmetic rather than about a database. This simulates a
 * long run of daily crons -- each firing at a random minute inside its scheduled hour, the
 * way Vercel's Hobby plan actually behaves -- and asserts that every thread produces
 * exactly one reminder per step it crosses: never zero (a rep silently never told), never
 * two (the same nag on consecutive mornings).
 *
 * Run with node:  node scripts/followup-selftest.js [path-to-conversations.json]
 * The optional argument is a raw inbox/GetConversationsV2 dump; without it the test runs on
 * synthetic threads that cover the edge cases directly.
 */

const { dueStep, findDue, anchorInstant, DAY_MS } = require('../lib/followup');
const { toThread } = require('../lib/inbox');

const STEPS = [
  { days: 7, label: '1 week' },
  { days: 11, label: '1.5 weeks' },
];
const HOUR_UTC = 14;

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok    ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Deterministic jitter so a failure is reproducible. */
function mulberry32(seed) {
  return function () {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fire one cron per day for `days`, at a random minute inside the scheduled hour, and
 * tally how many times each (thread, step) is reported.
 */
function simulate(threads, { days, startAt, goLiveAt, seed = 1 }) {
  const rand = mulberry32(seed);
  const tally = new Map();
  for (let d = 0; d < days; d++) {
    const scheduled = startAt + d * DAY_MS;
    const firedAt = scheduled + Math.floor(rand() * 60) * 60000; // 0-59 min late
    const evalAt = anchorInstant(firedAt, HOUR_UTC);
    for (const item of findDue(threads, { steps: STEPS, goLiveAt, evalAt })) {
      const key = `${item.thread.conversationId}|${item.step.days}`;
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
  }
  return tally;
}

/** Steps a thread ought to cross inside the simulated span. */
function expectedKeys(threads, { days, startAt, goLiveAt }) {
  const firstEval = anchorInstant(startAt, HOUR_UTC);
  const lastEval = firstEval + (days - 1) * DAY_MS;
  const keys = new Set();
  for (const t of threads) {
    for (const s of STEPS) {
      const crossedAt = t.lastMessageAt + s.days * DAY_MS;
      if (crossedAt > firstEval - DAY_MS && crossedAt <= lastEval && crossedAt >= goLiveAt) {
        keys.add(`${t.conversationId}|${s.days}`);
      }
    }
  }
  return keys;
}

function runSuite(label, threads, opts) {
  console.log(`\n${label} (${threads.length} threads, ${opts.days} daily runs)`);
  const tally = simulate(threads, opts);
  const expected = expectedKeys(threads, opts);

  const dupes = [...tally.entries()].filter(([, n]) => n > 1);
  check('no lead is reminded twice for the same step', dupes.length === 0,
    dupes.slice(0, 3).map(([k, n]) => `${k} fired ${n}x`).join('; '));

  const missing = [...expected].filter((k) => !tally.has(k));
  check('every crossing inside the window produced a reminder', missing.length === 0,
    `${missing.length} missing, e.g. ${missing.slice(0, 3).join(', ')}`);

  const unexpected = [...tally.keys()].filter((k) => !expected.has(k));
  check('no reminder fired for a crossing outside the window', unexpected.length === 0,
    `${unexpected.length} extra, e.g. ${unexpected.slice(0, 3).join(', ')}`);

  console.log(`  info  ${tally.size} reminders over ${opts.days} days`);
  return tally;
}

// ---------------------------------------------------------------- synthetic edge cases
const T0 = Date.UTC(2026, 8, 15, 14, 0, 0); // a Tuesday 14:00 UTC
const mk = (id, lastMessageAt, fromUs = true) => ({
  conversationId: id,
  leadName: id,
  senderAccountId: 1,
  lastMessageAt,
  lastMessageFromUs: fromUs,
  lastInboundAt: lastMessageAt,
  lastInboundText: 'x',
  totalMessages: 2,
  tags: ['Winnable'],
});

console.log('=== synthetic ===');
const synthetic = [
  mk('exactly-on-anchor', T0),                    // crossing lands exactly on an eval instant
  mk('one-ms-after-anchor', T0 + 1),              // just into the next window
  mk('one-ms-before-anchor', T0 - 1),             // just into the previous window
  mk('midday', T0 + 5 * 3600000),                 // crossing mid-window
  mk('overnight', T0 + 13 * 3600000),             // crossing just before the next anchor
];
runSuite('edge cases around the anchor', synthetic, {
  days: 40, startAt: T0 + DAY_MS, goLiveAt: 0, seed: 7,
});

// goLiveAt must suppress crossings that predate it, and nothing else.
{
  console.log('\ngo-live cutoff');
  const old = mk('already-cold', T0 - 30 * DAY_MS); // crossed both steps long ago
  const fresh = mk('crosses-later', T0 + 2 * DAY_MS);
  const goLiveAt = T0;
  const tally = simulate([old, fresh], { days: 40, startAt: T0, goLiveAt, seed: 3 });
  check('a thread that went cold before go-live is never reported',
    ![...tally.keys()].some((k) => k.startsWith('already-cold')));
  check('a thread crossing after go-live still fires both steps',
    [...tally.keys()].filter((k) => k.startsWith('crosses-later')).length === 2);
  console.log('  info  backfill=true surfaces the cold one:',
    dueStep(old, { steps: STEPS, goLiveAt, evalAt: T0 + 5 * DAY_MS, backfill: true })?.step.label);
}

// A reply from the sender must reset the clock and silence the remaining steps.
{
  console.log('\nself-clearing');
  const t = mk('gets-answered', T0);
  const before = dueStep(t, { steps: STEPS, goLiveAt: 0, evalAt: T0 + 7 * DAY_MS });
  t.lastMessageAt = T0 + 6 * DAY_MS; // the sender messages the lead on day 6
  const after = dueStep(t, { steps: STEPS, goLiveAt: 0, evalAt: T0 + 7 * DAY_MS });
  check('the 1-week step fires while the thread is untouched', before?.step.days === 7);
  check('messaging the lead silences it on the same day', after === null);
}

// ---------------------------------------------------------------- real inbox data
const dumpPath = process.argv[2];
if (dumpPath) {
  const raw = JSON.parse(require('fs').readFileSync(dumpPath, 'utf8'));
  const convs = Array.isArray(raw) ? raw : raw.items ?? [];
  const threads = convs
    .filter((c) => (c.correspondentProfile?.tags ?? []).includes('Winnable'))
    .map(toThread)
    .filter(Boolean);
  if (threads.length === 0) {
    console.log('\n=== real data === no Winnable-tagged conversations in the dump, skipping');
  } else {
    console.log('\n=== real data ===');
    const earliest = Math.min(...threads.map((t) => t.lastMessageAt));
    runSuite('live Winnable threads', threads, {
      days: 200, startAt: earliest - DAY_MS, goLiveAt: 0, seed: 11,
    });
  }
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
if (typeof process !== 'undefined' && process.exit) process.exit(failures === 0 ? 0 : 1);
