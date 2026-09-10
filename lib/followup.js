'use strict';

const DAY_MS = 86400000;

/**
 * The instant this run *evaluates as of*: the most recent occurrence of `hourUtc`.
 *
 * Not `now`, and that distinction is the whole reason exactly-once works without a
 * datastore. Vercel's Hobby crons fire anywhere inside their scheduled hour, so successive
 * runs sit 23-25h apart. Judged against wall-clock `now`, a 24h look-back either misses a
 * crossing that fell in a 24h45m gap or reports one twice across a 23h gap -- a rep gets
 * silence, or the same nag two mornings running.
 *
 * Anchoring to a fixed hour makes consecutive evaluations exactly 24h apart no matter when
 * the function actually woke up, so the look-back windows tile the timeline perfectly and
 * without overlap. Jitter stops mattering entirely.
 */
function anchorInstant(now, hourUtc) {
  const d = new Date(now);
  const anchor = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hourUtc, 0, 0, 0);
  // Before the anchor hour today (an early fire, or a manual call at breakfast) the run
  // still belongs to yesterday's window.
  return anchor <= now ? anchor : anchor - DAY_MS;
}

/**
 * Which follow-up step, if any, a thread crosses in the window ending at `evalAt`.
 *
 * There is no queue and no "already reminded" table behind this. Asking the obvious
 * question -- "is this thread overdue?" -- is true every single day once it becomes true,
 * so it would re-nag the same rep about the same lead forever. This asks the answerable
 * version instead: "did this thread cross a step inside the last 24h window?" A thread
 * crosses each step at one instant, that instant falls in exactly one window, so each lead
 * produces exactly one reminder per step while nothing at all is persisted.
 *
 * That is also what makes a reminder self-clearing. The clock is the newest message in
 * either direction, so the moment the sender messages the lead the age resets to zero, the
 * remaining steps move into the future, and the thread simply stops coming up. A rep clears
 * a reminder by doing the thing the reminder asked for, which is the only state worth
 * trusting.
 *
 * `goLiveAt` keeps the pre-existing backlog out. MakersHub had 60 winnable threads already
 * idle past a week when this was written; replaying their crossings would dump all 60 into
 * the channel on the first run. Crossings dated before go-live are skipped -- `backfill`
 * is the deliberate way to see them.
 */
function dueStep(thread, { steps, goLiveAt, evalAt, backfill = false }) {
  let found = null;
  for (const step of steps) {
    const crossedAt = thread.lastMessageAt + step.days * DAY_MS;
    if (crossedAt > evalAt) continue; // not there yet
    if (!backfill) {
      if (crossedAt < goLiveAt) continue; // pre-existing backlog, not ours to replay
      if (crossedAt <= evalAt - DAY_MS) continue; // crossed in an earlier window
    }
    // Highest step wins, so a backfill reports "1.5 weeks" once rather than every step
    // the thread has ever passed.
    if (!found || step.days > found.step.days) found = { step, crossedAt };
  }
  return found;
}

/** Whole days a thread has been silent, as of the evaluation instant. */
function idleDays(thread, evalAt) {
  return Math.floor((evalAt - thread.lastMessageAt) / DAY_MS);
}

/**
 * The reminders to post, most-neglected first.
 *
 * `weOweReply` separates the two ways a winnable thread goes cold, and they are not the
 * same failure. If the lead spoke last we never answered a live reply -- a dropped ball.
 * If we spoke last they went quiet on us -- an ordinary nudge. Sixteen of MakersHub's
 * winnable threads were in the first state when this was built, the oldest at 23 days.
 */
function findDue(threads, opts) {
  const out = [];
  for (const thread of threads) {
    const due = dueStep(thread, opts);
    if (!due) continue;
    out.push({
      thread,
      step: due.step,
      crossedAt: due.crossedAt,
      idleDays: idleDays(thread, opts.evalAt),
      weOweReply: !thread.lastMessageFromUs,
    });
  }
  return out.sort((a, b) => b.idleDays - a.idleDays);
}

module.exports = { anchorInstant, dueStep, idleDays, findDue, DAY_MS };
