# HeyReach agents

Two scheduled agents share this project, `lib/` and one Slack app:

- **Send-capacity warning agent** — are the senders going to run out of leads today?
- **[Follow-up tracker](#follow-up-tracker-winnable-replies)** — which winnable replies have gone cold?

---

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
| `queued` | `campaign/GetLeadsFromCampaign` across `IN_PROGRESS` campaigns **that open with a connection request**, counting leads that are `Pending`, or `InSequence` with `leadConnectionStatus: "None"` (sitting at the connection-check gate). Same two buckets the dashboard shows as **Pending** + **Conn. Check**. |

### Which campaigns count

Only campaigns whose sequence **opens by sending a connection request** contribute queued
inventory. First-degree campaigns target people the sender is already connected to and open
straight at `MESSAGE`, so their leads can never consume a connection-request slot.

This is decided by reading the sequence — `GET campaign/GetCampaignSequence`, the one HeyReach
endpoint that is a GET — and walking it from the root: `CONNECTION_REQUEST` means yes, a
messaging step means no, and `CHECK_IS_CONNECTION` is a gate so both branches are followed.
**Not by campaign name**, which is not a reliable signal. If a sequence cannot be read the
campaign is counted anyway: over-counting merely quietens an alert, whereas wrongly excluding a
real campaign would invent one.

This matters more than it sounds. Before it was added, 120 first-degree leads across four
MakersHub campaigns were being counted as connection-request inventory — Robert Scott 69,
Wesley Bauer 38, Charles Howe 13 — which hid two senders' shortfalls entirely and turned a real
"4 senders short, 67 leads" into "1 sender short, 23 leads".

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
| `SLACK_SIGNING_SECRET` | yes, for the follow-up buttons | From the Slack app's **Basic Information → App Credentials**. `api/slack/interactivity.js` is a public endpoint with no bearer token, so this signature is the only thing authenticating a button press. Without it the endpoint refuses every request. |
| `HEYREACH_KEY_ADVANCE` | yes | Advance workspace HeyReach key |
| `HEYREACH_KEY_MAKERSHUB` | yes | MakersHub workspace HeyReach key |
| `SLACK_OPS_CHANNEL` | recommended | Internal channel for failure notices. Without it, a crash is silent — and silence looks exactly like "nothing is wrong". |
| `DASHBOARD_URL` | optional | Adds a footer link back to the dashboard. Use `https://heyreach-remaining-leads.vercel.app`. |
| `SLACK_OVERRIDE_CHANNEL` | optional | Sends **every** client's alert here instead of its own channel. A channel id, or a **user id** to route it as a DM — `chat.postMessage` accepts a user id with only `chat:write`, so no extra scope is needed. Currently `U0BFP6A1PEK` (Effa), while the bot is not yet in the client channels. Delete the variable to go back to per-client channels; no code change. A redirected message footers "would normally post to #advance" so it is not mistaken for the client channel having been notified. |
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

**The panel renders a cached snapshot, not live data** — each workspace keeps its last sync in
`localStorage`, so after a code change the old numbers stay on screen until ↻ is pressed. A
snapshot carries `schemaVersion`, and one written by an older build is refused rather than
drawn: the panel reads *"cached by an older version… hit ↻ to recalculate"* with an **out of
date** pill. Bump `CAPACITY_SCHEMA` whenever the meaning of the numbers changes.

Because `localStorage` is scoped per origin, workspaces do not follow the dashboard to a
different domain (or to another browser or machine). **⚙ → Move workspaces to another browser**
exports the set as a JSON bundle to paste into the other origin's Import box. Only name and key
travel; campaign data is re-fetched there. Re-importing updates a matching name rather than
duplicating it, and a bare `[{"name":…,"key":…}]` array is accepted as well as a full bundle.
**The bundle holds HeyReach API keys in plaintext**, which the UI warns about — treat it like a
password and keep it out of Slack, Notion and tickets.

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


---

# Follow-up tracker (winnable replies)

Posts one Slack message per lead when a winnable reply has gone quiet, pinging the sender
who owns the thread. `api/cron/followup-check.js`, weekdays at 14:00 UTC (10:00 ET, as the
sending window opens).

## What counts as winnable

The `Winnable` tag on the lead in the HeyReach inbox — the same tag Advance already applies
during triage. The tracker does not grade reply text itself, and that is deliberate: a
human tag keeps the tracker and the inbox in agreement, so untagging a lead is all it takes
to stop the chasing.

It is also more accurate than the alternative. HeyReach's own `Interested` autoTag was
tested as a substitute and over-counts badly — it tagged "if you're selling something, I'm
not in need" as Interested. Advance's manual tagging does not make that mistake.

Leads also carrying `Not interested`, `Disqualified on facts` or `Addressed` are dropped
(`excludeTags`).
Neither currently co-occurs with `Winnable` in Advance's inbox, so the filter costs nothing
and means marking a lead dead is enough to end the reminders.

## The two steps

`7 days` → *1 week*, `11 days` → *1.5 weeks*, per client in `lib/clients.js`. Add or change
steps freely; nothing else needs touching.

Reminders come in two shapes, because a cold winnable thread fails in two different ways:

| Shape | Means | Icon |
|---|---|---|
| **Unanswered reply** | the lead spoke last and we never answered — a dropped ball | :rotating_light: |
| **Follow-up due** | we spoke last and they went quiet — an ordinary nudge | :hourglass_flowing_sand: |

## The two buttons

Each reminder carries two:

**`Addressed`** tags the lead `Addressed` in HeyReach and collapses the message to a single
line — `:white_check_mark: Resolved — Phil Slabine (Not Dorks…), addressed by @wbauer`.
Because `Addressed` is in `excludeTags`, the next run no longer sees that thread at all.
The state lives on the lead in the inbox, where the team already looks and where it is
visible and reversible — not in a table nobody can see. That is what keeps this stateless
even with a button on it.

If the tag write fails the click still resolves the message and says so
(`could not tag in HeyReach: …`) rather than pretending it worked. Worst case the thread
comes back at its next step.

**`Open in HeyReach`** is a plain link button. HeyReach has **no per-conversation deep
link** — its route table defines `inbox` with no id parameter and no conversation query
param — so the best available target is the Unibox, `https://app.heyreach.io/app/inbox`,
with the lead's name passed as `searchTerm` (the param HeyReach's list components read).
If that filters the inbox, the sender lands on the thread; if it is ignored they land in
the right inbox anyway. Worth spot-checking on the first click. Override per client with
`followUp.heyreachInboxUrl`.

### Wiring interactivity

1. api.slack.com/apps → your Kadima app → **Interactivity & Shortcuts** → on
2. Request URL: `https://<deployment>/api/slack/interactivity`
3. Copy **Basic Information → Signing Secret** into `SLACK_SIGNING_SECRET`

> **A Slack app has exactly one Interactivity Request URL.** If this app already points at
> something else, that integration breaks the moment you change it. Use a separate Slack
> app for the tracker if so.

The endpoint verifies Slack's `v0=` HMAC over `v0:<timestamp>:<raw body>` and rejects
anything older than five minutes, so a captured request cannot be replayed. It turns
Vercel's body parser off (`config.api.bodyParser = false`) because re-encoding a parsed
form changes the percent-escaping and the digest stops matching.

It also answers inside Slack's three-second budget by doing the tag write inline and
returning the replacement message as the response body. Deferring work until "after the
ack" is not an option: a Vercel function is frozen the moment it responds.

### One gap worth knowing

A lead marked `Addressed` stays out permanently, even if they reply again later. That new
reply still reaches the channel through the existing HeyReach "New Reply:" notification,
so nothing is lost — but the follow-up clock will not restart until someone clears the tag.
There is no `RemoveTags` endpoint; `lead/ReplaceTags` overwrites the whole list, or edit it
in the HeyReach UI.

## Why there is no database

The tracker stores nothing between runs, and does not need to.

**Reminders stop on their own.** The clock is the newest message in the thread in *either*
direction. The moment a sender messages the lead the age resets to zero, the remaining
steps move into the future, and the thread stops coming up. A rep clears a reminder by
doing the thing it asked for — the only state worth trusting. There is no button to press
and nothing that can drift out of sync with the inbox.

**Each step fires exactly once.** The run does not ask "is this overdue?" (true every day
once true, so it would nag forever) but "did this cross a step inside the last 24h window?"
A crossing is a single instant and falls in exactly one window.

**Cron jitter cannot break that.** Vercel's Hobby crons fire anywhere inside the scheduled
hour, so runs sit 23–25h apart. Measured against wall-clock `now`, a 24h look-back would
skip a crossing that fell in a 24h45m gap and double-report one across a 23h gap. So the
run judges itself as of a *fixed* instant — the most recent 14:00 UTC — which makes
consecutive evaluations exactly 24h apart no matter when the function actually woke up.
`evalHourUtc` in `lib/clients.js` must stay in step with the cron hour in `vercel.json`.

Verified rather than asserted: `scripts/followup-selftest.js` simulates 200 daily runs at
random minutes inside the hour against the 41 real `Winnable` threads in Advance's inbox
and checks that every thread produces exactly one reminder per step — 82 reminders, no
duplicates, no misses — plus the edge cases either side of the anchor instant.

```
node scripts/followup-selftest.js                       # synthetic edge cases
node scripts/followup-selftest.js /path/to/convs.json   # plus a real inbox dump
```

## Before it can do anything: create the tag

**MakersHub's inbox has only `Responded` on it. There is no `Winnable` tag yet, so the
tracker will report nothing until one exists and is being applied.**

Worth knowing: filtering by a tag that does not exist in a workspace is an HTTP 400, not an
empty result —

```
{"errorMessage":"Cannot filter with Tags because the following tags do not exist: Winnable"}
```

That is caught and reported as a `configWarning` rather than a crash, so the cron will not
502 and cry wolf every morning. It also posts to `SLACK_OPS_CHANNEL` once a week (Mondays)
so "nothing to read" cannot be mistaken indefinitely for "a quiet week".

To switch it on, create **two** tags in the MakersHub HeyReach workspace:

- **`Winnable`** — applied by hand during inbox triage, the way Advance does. This is what
  the tracker reads.
- **`Addressed`** — written by the Slack button. Create it up front: whether `lead/AddTags`
  creates a tag that does not yet exist could not be verified without writing to a real
  lead in a client workspace, so do not rely on it.

## The existing backlog

`goLiveAt` (`2026-09-11` for MakersHub) stops the tracker replaying crossings that happened
before it was switched on. MakersHub had 60 threads already idle past a week when this was
built; without the cutoff every one would land in the channel on the first run.

To work that backlog deliberately, use `?backfill=1`, which ignores both `goLiveAt` and the
24h window and reports the furthest step each overdue thread has passed. It will re-report
leads already reminded about, so dry-run it first and expect volume.

## Where it posts

`#kadima-makershub-responses` (`C0BMB34K2VD`) — **not** `#makershub`, which is Kadima-internal
(Yael and Effa only). The reminders have to land where the six senders are, which is the
same channel HeyReach already posts "New Reply:" notifications into.

Senders are mapped to Slack user ids in `lib/clients.js` so the ping is a real `<@id>`
mention. The map is keyed by **HeyReach LinkedIn account id, not by name** — HeyReach calls
him "Charles Howe" and Slack calls him "Charley Howe", and a name-matched map would
silently drop his reminders. If an id is missing the name is bolded instead and the
reminder still posts.

| HeyReach account | Sender | Slack |
|---|---|---|
| 227672 | Sam Grasso | `U087F3EA1D0` |
| 228534 | Charles Howe | `U064CLEHZEZ` |
| 228829 | Wesley Bauer | `U08LV8JN97X` |
| 228966 | Sonny Singh | `U09BR825HDJ` |
| 230914 | Robert Scott | `U094JF03PNJ` |
| 233402 | Phong Ngo | `U06412970DV` |

Invite the bot: `/invite @<app name>` in `#kadima-makershub-responses`.

## Advance

Configured but `enabled: false`. Advance already tags `Winnable` (41 leads today), so the
only thing missing is somewhere to post: its senders are not in `#advance`, which has only
the Kadima side in it, and there is no responses channel. Create one, invite the senders,
fill in `senders` with their Slack ids, set `channel`, set `goLiveAt`, flip `enabled`.

## Testing

```bash
BASE=https://<deployment>.vercel.app
AUTH="Authorization: Bearer $CRON_SECRET"

curl -s -H "$AUTH" "$BASE/api/cron/followup-check?dryRun=1" | jq .
curl -s -H "$AUTH" "$BASE/api/cron/followup-check?dryRun=1&backfill=1&client=makershub" | jq '.results[0].leads'
curl -s -H "$AUTH" "$BASE/api/cron/followup-check?backfill=1&limit=5"   # posts 5, for real
```

Set `SLACK_OVERRIDE_CHANNEL` to your own user id to watch a few real days land in a DM
before the senders see any of it.

| Param | Effect |
|---|---|
| `dryRun=1` | build the payloads, post nothing |
| `backfill=1` | ignore `goLiveAt` and the 24h window; report everything currently overdue |
| `client=` | restrict to one client key |
| `limit=` | cap posts (default 25) |

## Operational notes

- **Cost.** One paged read of the tagged conversations per client — 1 call per 100 threads.
  Advance's 41 `Winnable` threads are a single call. Far cheaper than the capacity check.
- **Posting is serialised** at ~1.2s per message. `chat.postMessage` is rate limited near
  one per second per channel and a burst is dropped rather than queued, so a `limit=25`
  backfill takes ~30s of the 60s budget.
- **A double-fired cron double-posts.** Vercel can occasionally fire the same schedule
  twice; both fires resolve to the same evaluation instant and so find the same crossings.
  The duplicate is identical and harmless, and stateless dedupe cannot rule it out — this
  is the one case the exactly-once property does not cover.
- **A missed run silently skips a step.** No retry, and the window has passed by the next
  run. The lead still gets its later step; use `?backfill=1` to catch anything dropped.
- **`filters.tags` is the right field.** `leadTags` looks plausible, is accepted with a 200,
  and is silently ignored — it returns the entire inbox, which reads as "everything is
  winnable" rather than as an error.
- **Campaign attribution comes from the lead's `autoTags`**, which carry `campaignName`
  alongside the sentiment label — no second query needed. `filters.campaignIds` also works,
  but 400s ("The campaign you are trying to open does not exist") on an id belonging to a
  different workspace than the key, which reads like the filter being unsupported.
- **Button presses are not rate limited.** Each is one HeyReach write, and only a sender
  who can see the channel can press one, so there is nothing to throttle.
- **Email is not covered.** MakersHub runs 7 Instantly campaigns, but Instantly has no
  equivalent winnable signal in use — `lt_interest_status` is unset on essentially every
  lead. Once replies are graded there, the same steps and message builder apply.
