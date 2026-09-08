#!/usr/bin/env python3
"""
Local validator for the send-capacity agent — mirrors lib/capacity.js + lib/message.js
and prints what would be posted, without touching Slack.

    python3 scripts/dry_run.py                        # today's assessment, every client
    python3 scripts/dry_run.py --client advance
    python3 scripts/dry_run.py --window               # re-derive the window from send history
    python3 scripts/dry_run.py --at 2026-09-08T09:45  # pretend it is this local time

Reads HeyReach keys from HEYREACH_KEY_ADVANCE / HEYREACH_KEY_MAKERSHUB, or from an env
file passed with --keys (KEY=value lines; HR_advance / HR_makershub also accepted).
"""
import argparse
import collections
import datetime
import json
import os
import sys
import urllib.error
import urllib.request
import zoneinfo
from concurrent.futures import ThreadPoolExecutor

BASE = "https://api.heyreach.io/api/public"
PAGE_SIZE = 100  # HeyReach 400s on anything larger
UA = "kadima-capacity-agent/1.0"
CONCURRENCY = 6

# Mirrors lib/clients.js — keep the two in step.
CLIENTS = [
    {"key": "advance", "label": "Advance", "slack": "C0BKN29JN9W",
     "env": "HEYREACH_KEY_ADVANCE", "alias": "HR_advance",
     "tz": "America/New_York", "start": "10:00", "end": "20:00", "send_days": [0, 1, 2, 3, 4]},
    {"key": "makershub", "label": "MakersHub", "slack": "C0BH2GBG0NM",
     "env": "HEYREACH_KEY_MAKERSHUB", "alias": "HR_makershub",
     "tz": "America/New_York", "start": "10:00", "end": "20:00", "send_days": [0, 1, 2, 3, 4]},
]


def post(api_key, path, body):
    req = urllib.request.Request(
        BASE + path, data=json.dumps(body).encode(),
        headers={"X-API-KEY": api_key, "Content-Type": "application/json", "User-Agent": UA})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code < 500 and e.code != 429:
                raise
        except Exception:
            if attempt == 2:
                raise
    raise RuntimeError("retries exhausted for %s" % path)


def parse_ts(s):
    """HeyReach emits fractional seconds of varying length; pad to 6 digits."""
    s = s.replace("Z", "+00:00")
    if "." in s:
        head, rest = s.split(".", 1)
        frac, tz = rest[:-6], rest[-6:]
        s = "{}.{}{}".format(head, frac.ljust(6, "0")[:6], tz)
    return datetime.datetime.fromisoformat(s)


def get_senders(api_key):
    out = []
    for a in post(api_key, "/li_account/GetAll", {"offset": 0, "limit": PAGE_SIZE}).get("items", []):
        lim = a.get("accountLimits") or {}
        out.append({
            "id": a["id"],
            # HeyReach pads some firstName values, so collapse internal whitespace too
            "name": " ".join(("%s %s" % (a.get("firstName") or "", a.get("lastName") or "")).split()) or "#%s" % a["id"],
            "is_active": a.get("isActive") is True,
            "auth_ok": a.get("authIsValid") is True,
            "active_campaigns": a.get("activeCampaigns") or 0,
            "cooldown": a.get("connectionRequestCooldown") is True,
            # HeyReach's own spelling: the 'n' really is missing from connectioRequestLimit
            "daily_limit": lim.get("connectioRequestLimit") or 0,
        })
    return out


def get_active_campaigns(api_key):
    items = post(api_key, "/campaign/GetAll", {"offset": 0, "limit": PAGE_SIZE}).get("items", [])
    return [{"id": c["id"], "name": c["name"]} for c in items if c.get("status") == "IN_PROGRESS"]


def get_queued_by_sender(api_key, campaign_id):
    """Leads still awaiting a connection request: Pending, or InSequence at the conn-check gate."""
    by_sender = collections.Counter()
    offset, total = 0, None
    while total is None or offset < total:
        page = post(api_key, "/campaign/GetLeadsFromCampaign",
                    {"campaignId": campaign_id, "offset": offset, "limit": PAGE_SIZE})
        if total is None:
            total = page.get("totalCount", 0)
            if total == 0:
                break
        for lead in page.get("items", []):
            status, conn = lead.get("leadCampaignStatus"), lead.get("leadConnectionStatus")
            if status == "Pending" or (status == "InSequence" and conn == "None"):
                sid = lead.get("linkedInSenderId")
                if sid is not None:
                    by_sender[sid] += 1
        offset += PAGE_SIZE
    return by_sender


def get_sent_today(api_key, sender_id, now):
    """UTC calendar day. Agrees with the ET business day at the times the crons fire
    (13:00/18:00 UTC); diverges after 20:00 ET. See the note in lib/heyreach.js."""
    day = now.astimezone(datetime.timezone.utc).strftime("%Y-%m-%d")
    j = post(api_key, "/stats/GetOverallStats", {
        "accountIds": [sender_id], "campaignIds": [],
        "startDate": day + "T00:00:00.000Z", "endDate": day + "T23:59:59.999Z"})
    return sum(d.get("connectionsSent", 0) for d in (j.get("byDayStats") or {}).values())


def window_state(client, now):
    local = now.astimezone(zoneinfo.ZoneInfo(client["tz"]))
    to_min = lambda s: int(s[:2]) * 60 + int(s[3:])
    start, end = to_min(client["start"]), to_min(client["end"])
    cur = local.hour * 60 + local.minute
    frac = min(1.0, max(0.0, (cur - start) / float(end - start)))
    return {
        "local": local, "now_min": cur,
        "is_send_day": local.weekday() in client["send_days"],
        "before": cur < start, "after": cur >= end,
        "to_start": start - cur, "to_end": end - cur,
        "elapsed_pct": int(round(frac * 100)),
        "start_label": clock(start), "end_label": clock(end),
        "tz_label": local.strftime("%Z").replace("DT", "T").replace("ST", "T"),
    }


def clock(minutes):
    h24, m = (minutes // 60) % 24, minutes % 60
    h12 = 12 if h24 % 12 == 0 else h24 % 12
    suffix = "AM" if h24 < 12 else "PM"
    return "{}{}".format(h12, suffix) if m == 0 else "{}:{:02d}{}".format(h12, m, suffix)


def human_duration(minutes):
    a = abs(int(round(minutes)))
    if a < 60:
        return "%dm" % a
    h, m = divmod(a, 60)
    return "%dh" % h if m == 0 else "%dh %dm" % (h, m)


def assess(client, api_key, now):
    with ThreadPoolExecutor(max_workers=2) as ex:
        f_senders, f_camps = ex.submit(get_senders, api_key), ex.submit(get_active_campaigns, api_key)
        senders, campaigns = f_senders.result(), f_camps.result()

    with ThreadPoolExecutor(max_workers=CONCURRENCY) as ex:
        per_campaign = list(ex.map(lambda c: (c, get_queued_by_sender(api_key, c["id"])), campaigns))

    queued = collections.Counter()
    camps_by_sender = collections.defaultdict(list)
    for camp, by_sender in per_campaign:
        for sid, n in by_sender.items():
            queued[sid] += n
            camps_by_sender[sid].append({"id": camp["id"], "name": camp["name"], "queued": n})

    # Active senders stay in scope even with zero queued leads — that is the case to catch.
    in_scope = [s for s in senders if s["is_active"]]
    with ThreadPoolExecutor(max_workers=CONCURRENCY) as ex:
        sent = list(ex.map(lambda s: get_sent_today(api_key, s["id"], now), in_scope))

    rows = []
    for s, sent_today in zip(in_scope, sent):
        q = queued.get(s["id"], 0)
        remaining = max(0, s["daily_limit"] - sent_today)
        blocked = None
        if not s["auth_ok"]:
            blocked = "LinkedIn auth invalid"
        elif s["cooldown"]:
            blocked = "connection-request cooldown"
        elif s["active_campaigns"] == 0:
            blocked = "not in any active campaign"
        rows.append(dict(s, sent_today=sent_today, queued=q, remaining=remaining,
                         shortfall=max(0, remaining - q), blocked=blocked,
                         campaigns=sorted(camps_by_sender.get(s["id"], []), key=lambda c: c["queued"])))
    return {
        "client": client, "campaigns": campaigns, "senders": rows,
        "at_risk": [r for r in rows if r["shortfall"] > 0 and not r["blocked"]],
        "blocked": [r for r in rows if r["blocked"]],
        # shortfall is summed over at-risk senders only — see the note in lib/capacity.js
        "totals": dict({k: sum(r[k] for r in rows) for k in ("daily_limit", "sent_today", "queued")},
                       shortfall=sum(r["shortfall"] for r in rows if r["shortfall"] > 0 and not r["blocked"])),
    }


def render(a, st, run):
    """Mirrors lib/message.js — headline, one context line, at-risk bullets, full sender table."""
    label = a["client"]["label"]
    t, at_risk, blocked = a["totals"], a["at_risk"], a["blocked"]
    if not at_risk and not blocked:
        return None

    if at_risk:
        deadline = " before %s %s" % (st["start_label"], st["tz_label"]) if st["before"] else ""
        head = "\U0001F534 *%s - re-up %s lead%s%s*" % (
            label, "{:,}".format(t["shortfall"]), "" if t["shortfall"] == 1 else "s", deadline)
    else:
        head = "\U0001F7E1 *%s - %d sender%s blocked*" % (
            label, len(blocked), "" if len(blocked) == 1 else "s")

    # No aggregate "N queued" figure on purpose — see the note in lib/message.js.
    short_of = (" - *%d of %d* senders out of leads" % (len(at_risk), len(a["senders"]))) if at_risk else ""
    if run == "preflight" and st["before"]:
        ctx = "Opens in %s - %d connection requests planned today%s" % (
            human_duration(st["to_start"]), t["daily_limit"], short_of)
    else:
        # human_duration is unsigned, so a closed window needs its own phrasing
        when = ("%s left, %d%% through" % (human_duration(st["to_end"]), st["elapsed_pct"])
                if st["to_end"] > 0 else "window closed %s ago" % human_duration(st["to_end"]))
        ctx = "%s - *%d of %d* sent%s" % (when, t["sent_today"], t["daily_limit"], short_of)

    out = ["%s\n%s" % (head, ctx)]
    if at_risk:
        out.append("\n".join(sender_line(r) for r in sorted(at_risk, key=urgency)))
    out.append(sender_table(a["senders"]))
    if blocked:
        out.append("\U0001F7E1 Blocked - leads won't help: " +
                   ", ".join("*%s* (%s)" % (r["name"], r["blocked"]) for r in blocked))
    return "\n\n".join(out)


def urgency(r):
    """Worst first."""
    return (-(r["shortfall"] or 0), r["name"])


def sender_table(senders):
    """~41 columns so it does not wrap in Slack on a phone."""
    rows = ["{:<16}{:>5}{:>6}{:>7}{:>7}".format("Sender", "Lim", "Sent", "Queue", "Re-up")]
    for r in sorted(senders, key=urgency):
        reup = "blkd" if r["blocked"] else (str(r["shortfall"]) if r["shortfall"] > 0 else "-")
        rows.append("{:<16}{:>5}{:>6}{:>7}{:>7}".format(
            r["name"][:15], r["daily_limit"], r["sent_today"], r["queued"], reup))
    return "```\n%s\n```" % "\n".join(rows)


def sender_line(r):
    if not r["campaigns"]:
        where = "nothing queued in %d campaign%s" % (
            r["active_campaigns"], "" if r["active_campaigns"] == 1 else "s")
    else:
        c = r["campaigns"][0]
        where = "{:,} queued, thinnest {} `#{}` ({})".format(r["queued"], c["name"], c["id"], c["queued"])
    return "- *%s* - *%d* short - %s" % (r["name"], r["shortfall"], where)


def derive_window(api_key, label, days=21):
    """Rebuild the send window from the hour histogram of connection actions."""
    cut = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=days)
    et = zoneinfo.ZoneInfo("America/New_York")
    hrs, dows, n = collections.Counter(), collections.Counter(), 0
    for camp in get_active_campaigns(api_key):
        offset, total = 0, None
        while total is None or offset < total:
            page = post(api_key, "/campaign/GetLeadsFromCampaign",
                        {"campaignId": camp["id"], "offset": offset, "limit": PAGE_SIZE})
            if total is None:
                total = page.get("totalCount", 0)
                if total == 0:
                    break
            for lead in page.get("items", []):
                lat = lead.get("lastActionTime")
                if not lat or lead.get("leadConnectionStatus") not in ("ConnectionSent", "Connected"):
                    continue
                d = parse_ts(lat)
                if d < cut:
                    continue
                e = d.astimezone(et)
                hrs[e.hour] += 1
                dows[e.strftime("%a")] += 1
                n += 1
            offset += PAGE_SIZE
    print("\n=== %s - %d connection actions over %d days, America/New_York ===" % (label, n, days))
    if not n:
        return
    peak = max(hrs.values())
    for h in range(24):
        if hrs[h]:
            print("  %02d:00  %s %d" % (h, "#" * max(1, hrs[h] * 44 // peak), hrs[h]))
    live = [h for h in range(24) if hrs[h] >= n * 0.01]
    print("  -> window %02d:00-%02d:00 ET | weekdays %s" % (min(live), max(live) + 1, dict(dows)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--client")
    ap.add_argument("--keys", help="path to a KEY=value env file")
    ap.add_argument("--window", action="store_true", help="re-derive the send window from history")
    ap.add_argument("--at", help="pretend it is this local ISO time, e.g. 2026-09-08T09:45")
    ap.add_argument("--run", choices=["preflight", "midday"])
    ap.add_argument("--force", action="store_true", help="ignore the send-day and after-window guards")
    args = ap.parse_args()

    env = dict(os.environ)
    if args.keys:
        with open(args.keys) as fh:
            for line in fh:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    env[k] = v

    clients, missing = [], []
    for c in CLIENTS:
        if args.client and c["key"] != args.client:
            continue
        key = env.get(c["env"]) or env.get(c["alias"])
        if key:
            clients.append(dict(c, api_key=key))
        else:
            missing.append("%s (%s or %s)" % (c["key"], c["env"], c["alias"]))
    if missing:
        print("skipping, no key: %s" % ", ".join(missing), file=sys.stderr)
    if not clients:
        sys.exit("no HeyReach keys available")

    if args.window:
        for c in clients:
            derive_window(c["api_key"], c["label"])
        return

    now = datetime.datetime.now(datetime.timezone.utc)
    if args.at:
        naive = datetime.datetime.fromisoformat(args.at)
        now = naive.replace(tzinfo=zoneinfo.ZoneInfo(clients[0]["tz"])).astimezone(datetime.timezone.utc)

    for c in clients:
        st = window_state(c, now)
        run = args.run or ("preflight" if st["before"] else "midday")
        print("\n" + "=" * 78)
        print("%s | local %s | run=%s | send day=%s | %d%% through window"
              % (c["label"], st["local"].strftime("%a %Y-%m-%d %H:%M %Z"), run,
                 st["is_send_day"], st["elapsed_pct"]))
        print("=" * 78)
        if not st["is_send_day"] and not args.force:
            print("  SKIP - not a send day (--force to run anyway)")
            continue
        if st["after"] and not args.force:
            print("  SKIP - sending window already closed (--force to run anyway)")
            continue
        a = assess(c, c["api_key"], now)
        print("\n%-18s%6s%6s%8s%8s%8s  %s"
              % ("sender", "limit", "sent", "queued", "capac.", "re-up", "blocked"))
        for r in a["senders"]:
            print("%-18s%6d%6d%8d%8d%8d  %s" % (r["name"][:17], r["daily_limit"], r["sent_today"],
                                                r["queued"], r["remaining"], r["shortfall"], r["blocked"] or ""))
        print("%-18s%6d%6d%8d%8s%8d" % ("TOTAL", a["totals"]["daily_limit"], a["totals"]["sent_today"],
                                        a["totals"]["queued"], "", a["totals"]["shortfall"]))
        msg = render(a, st, run)
        print("\n--- slack message " + "-" * 60)
        print(msg if msg else "(nothing to post - capacity is covered)")
        print("-" * 78)


if __name__ == "__main__":
    main()
