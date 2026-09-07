'use strict';

/** Calendar/clock fields for `date` as seen in `timeZone`. */
function zonedParts(date, timeZone) {
  const parts = {};
  for (const { type, value } of new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date)) {
    parts[type] = value;
  }
  const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Intl can emit hour "24" for midnight depending on the locale/ICU build.
    hour: parts.hour === '24' ? 0 : Number(parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAYS[parts.weekday],
    weekdayName: parts.weekday,
  };
}

const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

function formatClock(minutes, { pad = false } = {}) {
  const h24 = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const suffix = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const hour = pad ? String(h12).padStart(2, ' ') : String(h12);
  return m === 0 ? `${hour}${suffix}` : `${hour}:${String(m).padStart(2, '0')}${suffix}`;
}

function humanDuration(minutes) {
  const abs = Math.abs(Math.round(minutes));
  if (abs < 60) return `${abs}m`;
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * Where `now` sits relative to the client's sending window.
 *
 * `elapsedFraction` is what makes the halfway run meaningful: it is how much of today's
 * window has already burned, so the message can say "we are 48% through the day" rather
 * than trusting the cron to have fired exactly at the midpoint (Vercel's Hobby plan can
 * fire anywhere inside the scheduled hour).
 */
function windowState(client, now = new Date()) {
  const local = zonedParts(now, client.timeZone);
  const startMin = toMinutes(client.window.start);
  const endMin = toMinutes(client.window.end);
  const nowMin = local.hour * 60 + local.minute;
  const span = endMin - startMin;

  const isSendDay = client.sendDays.includes(local.weekday);
  const elapsedFraction = Math.min(1, Math.max(0, (nowMin - startMin) / span));

  return {
    local,
    isSendDay,
    startMin,
    endMin,
    nowMin,
    startLabel: formatClock(startMin),
    endLabel: formatClock(endMin),
    beforeWindow: nowMin < startMin,
    afterWindow: nowMin >= endMin,
    minutesToStart: startMin - nowMin,
    minutesToEnd: endMin - nowMin,
    elapsedFraction,
    elapsedPct: Math.round(elapsedFraction * 100),
  };
}

module.exports = { zonedParts, toMinutes, formatClock, humanDuration, windowState };
