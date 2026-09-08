# Send-capacity warning agent

Warns in each client's Slack channel when a HeyReach sender is going to end the day under
its daily connection-request limit purely because it has run out of leads — early enough
that the leads can still be re-upped.

Runs twice a weekday as a Vercel Cron on this project, deployed at
**https://heyreach-remaining-leads.vercel.app**.

## What it measures

Per LinkedIn sender, per client:

```
remainingCapacity = dailyLimit - sentToday        CRs the sender could still send today
shortfall         = remainingCapacity - queued    leads that must be added to fill it
```

| Term | Source |
|---|---|
| `dailyLimit` | `li_account/GetAll` → `accountLimits.connectioRequestLimit` (HeyReach's own spelling; the `n` is missing). This is the *current, ramped* limit, not the `…Max` ceiling. |
| `sentToday` | `stats/GetOverallStats` with `accountIds:[id]` for today → sum `connectionsSent` over `byDayStats`. **UTC day**, because `byDayStats` has no finer granularity. Both crons fire mid-window (13:00/18:00 UTC), where UTC day and ET business day agree; they diverge only after 20:00 ET, so a forced out-of-window run reports ~0 sent and an inflated shortfall. |
| `queued` | `campaign/GetLeadsFromCampaign` across `IN_PROGRESS` campaigns, counting leads that are `Pending`, or `InSequence` with `leadConnectionStatus: "None"` (sitting at the connection-check gate). Same two buckets the dashboard shows as **Pending** + **Conn. Check**. |

A sender with `shortfall > 0` is reported as needing a re-up. Senders blocked for a
*different* reason — invalid LinkedIn auth, a connection-request cooldown, or membership in
no active campaign — are listed separately, because adding leads will not fix those.

## Schedule

`vercel.json` registers two crons on `/api/cron/capacity-check`. **Vercel cron expressions
are UTC.**

| Cron | UTC | ET (summer) | Purpose |
|---|---|---|---|
| `0 13 * * 1-5` | 13:00 | 9:00 AM | Before the window opens — re-up before anything sends |
| `0 18 * * 1-5` | 18:00 | 2:00 PM | Mid-window — catch anything not re-upped since |

The handler does **not** decide which run it is from the cron header. It derives that from
where the client's clock actually sits, so a late invocation still reads correctly — on the
Hobby plan Vercel may fire anywhere inside the scheduled hour. It also skips non-send days
and any run after the window has closed.

DST: the crons are fixed UTC, so in winter they land an hour earlier in ET (8:00 AM and
1:00 PM). Both remain fit for purpose — the first is still before the 10:00 AM open and the
second is still mid-window — so there is nothing to change twice a year.

## The sending window

**HeyReach's public API does not expose campaign schedules.** `campaign/GetById`,
`campaign/GetCampaignSchedule`, `campaign/GetWorkingHours` and `li_account/GetSchedule` were
all probed; only `campaign/GetCampaignSequence` returns anything, and that is the node tree,
not the schedule. So the window lives in `lib/clients.js`.

The committed value is **10:00–20:00 America/New_York, Mon–Fri**, derived from the hour
histogram of `lastActionTime` on leads that reached `ConnectionSent`/`Connected` over a
21-day lookback. Both workspaces agree, with zero activity outside it (n=953 Advance,
n=1588 MakersHub).

Note that 10:00–20:00 Eastern is **08:00–18:00 Mountain** — so the schedule set in HeyReach
is very likely 8am–6pm in Mountain time, not Eastern. Worth confirming in the UI. Re-derive
the observed window any time with:

```bash
python3 scripts/dry_run.py --window --keys /path/to/keys.env
```

## Environment variables

Set these in **Project → Settings → Environment Variables** (Production).

| Variable | Required | Notes |
|---|---|---|
| `CRON_SECRET` | yes | Random string, 16+ chars. Vercel sends it as `Authorization: Bearer <value>`. The handler returns 500 rather than running if it is unset, so the endpoint can never be left open. |
| `SLACK_BOT_TOKEN` | yes | `xoxb-…`, needs the `chat:write` scope, and the bot must be invited to each channel. |
| `HEYREACH_KEY_ADVANCE` | yes | Advance workspace HeyReach key |
| `HEYREACH_KEY_MAKERSHUB` | yes | MakersHub workspace HeyReach key |
| `SLACK_OPS_CHANNEL` | recommended | Internal channel for failure notices. Without it, a crash is silent — and silence looks exactly like "nothing is wrong". |
| `DASHBOARD_URL` | optional | Adds a footer link back to the dashboard. Use `https://heyreach-remaining-leads.vercel.app`. |
| `POST_ALL_CLEAR` | optional | `1` posts a green "capacity is covered" message too. Default is to stay quiet unless there is a problem. |

A client whose `HEYREACH_KEY_*` is absent is skipped rather than erroring, so clients can be
added or removed by env var alone.

### Slack app setup

1. api.slack.com/apps → your Kadima app → **OAuth & Permissions**
2. Add bot scope `chat:write`, install to the workspace, copy the `xoxb-…` token
3. Invite the bot to both channels: `/invite @<app name>` in `#advance` and `#makershub`

Channel IDs are already in `lib/clients.js`: `#advance` `C0BKN29JN9W`,
`#makershub` `C0BH2GBG0NM`.

## Testing before you trust it

Locally, without Node or Slack — this mirrors the same logic and prints the message that
would be posted:

```bash
python3 scripts/dry_run.py --keys /path/to/keys.env
python3 scripts/dry_run.py --keys /path/to/keys.env --client advance
python3 scripts/dry_run.py --keys /path/to/keys.env --at 2026-09-08T09:45  # preflight framing
```

Against the deployed function — computes and returns the Slack payloads without posting:

```bash
curl -s -H "x-cron-secret: $CRON_SECRET" \
  "https://<deployment>/api/cron/capacity-check?dryRun=1" | python3 -m json.tool
```

Useful query params, all manual-testing only:

| Param | Effect |
|---|---|
| `dryRun=1` | Compute and return the payloads, post nothing |
| `force=1` | Ignore the send-day and after-window guards |
| `run=preflight` / `run=midday` | Force the framing |
| `client=advance` | Restrict to one client |

## The dashboard panel

The same math also drives a **Daily connection quota** panel in the dashboard itself, sitting
between the KPI row and the campaign table. One row per active sender, with a bar whose full
width is that sender's daily limit, split three ways:

| Segment | Meaning |
|---|---|
| Green, solid | already sent today |
| Green, translucent | covered by leads still queued |
| Dark red, hatched | the gap — quota that has no leads behind it |

Green covers everything that will get sent; dark red is the shortfall. The gap keeps a hatch
pattern deliberately: green-vs-red is precisely the pairing red-green colour blindness
collapses, so the distinction must not rest on hue alone. `--q-fill` and `--q-gap` in the
`:root` block are the only two values to change if the palette is revisited.

The pill top-right reads **quota covered** or **re-up N leads**. A sender whose today-stats
call fails shows `no data` with its queued inventory against the full limit rather than an
empty bar, so "unknown" never reads as "nothing queued". A sender that is blocked for a
non-lead reason shows `blocked` and is left out of the re-up total.

Per-sender queued counts are tallied during the lead pagination the dashboard already does, so
the panel costs only one extra `li_account/GetAll` call plus one `stats/GetOverallStats` per
sender. It needs two proxy routes that were added alongside the existing ones:
`api/li_account/GetAll.js` and `api/stats/GetOverallStats.js`. The local Python server is a
catch-all proxy and needed no change.

Both `index.html` (Vercel, `HR_API = '/api'`) and `heyreach-dashboard.html` (local server,
`HR_API = '/heyreach-api'`) carry the panel. **That one line is the only difference between
the two files — keep it that way when editing either.**

To see it locally:

```bash
python3 heyreach-server.py            # serves this directory on :8765
open http://localhost:8765/heyreach-dashboard.html
```

Then add a workspace with its HeyReach key via ⚙ and hit ↻. The key is held in that browser's
`localStorage` only.

The deployed copy is `index.html` at https://heyreach-remaining-leads.vercel.app. The panel
needs the two proxy routes above, so **it only appears once this is deployed** — against an
older deployment those routes 404 and the panel reports `unavailable`. That failure is
contained — the campaign table below still loads normally.

## Operational notes

- **Cost.** One run is roughly 90 HeyReach calls (~55 of them lead pages) across both
  clients, ~20s wall clock at concurrency 6. `maxDuration` is set to 60s. If a client grows
  past ~10k leads in active campaigns, split the crons per client rather than raising the
  timeout.
- **Page size is hard-capped at 100.** HeyReach 400s on 200 or more, so lead pagination
  cannot be made cheaper that way.
- **Delivery is best effort.** Vercel does not retry a failed cron, and can occasionally
  fire the same schedule twice. A missed run means no warning; a duplicate means the same
  warning posted twice. Neither corrupts anything, so no lock is used.
- **`stats/GetOverallStats` needs its dates.** Omitting them returns all history, not today.
- **Ignore `auth/CheckApiKey`.** It returns a non-JSON body and looks like a failure.
