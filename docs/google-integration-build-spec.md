# Google Calendar integration — build spec

> **Milestone: 0.8 (the next minor).** This is its own milestone, so the whole
> feature shares ONE minor bump: it lands as `0.8.0-alpha`; sub-passes and
> follow-ups inside it bump PATCH (the consequence-graph two-pass precedent —
> see CLAUDE.md "One milestone = one minor"). The feature branch name owns the
> 0.8 slot; ancillary work elsewhere stays 0.7.x PATCH until this lands.

## 0. Before you write a line

Read these first — they constrain everything below:

- **`docs/unruh-design.md`** and **`unruh/src/unruh/schedule.py`** — the schedule
  node model this feeds. Nodes are `event | task | phase | state | reminder`,
  with `when_ts` / `end_ts` columns and an arbitrary `payload_json`. Recurrence
  lives in `payload.recurrence` (`{freq, interval, byweekday, bysetpos}` — see
  `recurrence.js` for the exact shape the expander understands).
- **`docs/consequence-graph-build-spec.md`** — the projection step new nodes get
  routed into (§4 here). We are reusing `schedule_link` and the both-futures
  authoring discipline, not inventing a new one.
- **CLAUDE.md**, specifically: graceful-degradation (every loop ships a hard
  off-switch + Settings toggle in the same commit; one peer down never touches
  the chat path), "ride existing requests; gate in code", "no copy-paste of
  substantial logic", "every capability must be reachable BY the Familiar"
  (discoverability + operability), and "LLM-generated values must not be the
  source of truth" — **this last one is the spine of the whole feature** (§3).

**Why this feature exists, in one line:** the Familiar should never hand-type a
calendar URL, an `.ics` file, or an event's date math — those are exactly the
exact-string/exact-number tasks LLMs get subtly wrong (same failure class as the
hallucinated `[HH:MM]` timestamps we strip). Google's own machinery and Unruh's
deterministic code own the bytes; the Familiar only ever references a node by
`id` and speaks about it.

### The two data flows (keep them separate in your head)

```
  INBOUND  (mechanical, no Familiar involvement)
  Google Calendar ──shareable iCal link / gcalcli──▶ Node fetch ──▶ Unruh upsert
                                                                       │
                                                                       ▼
                                                            new nodes flagged
                                                            needs_projection
                                                                       │
                                                                       ▼
                                                     Familiar prompted: PROJECT
                                                     (author both futures) — and
                                                     that is the ONLY thing that
                                                     fires for an ingested item.

  OUTBOUND (Familiar-initiated, deterministic)
  Familiar pokes Unruh with a node id ──▶ Unruh emits .ics file + "add to Google"
  link  ──▶ delivered to the human. (Advanced: gcalcli writes it to Google directly.)
```

### Two tiers

| Tier | Who | Auth | Inbound | Outbound |
|------|-----|------|---------|----------|
| **Link** (out-of-the-box) | everyone | none — paste a secret iCal URL | poll the iCal feed, read-only | `.ics` file + "add to Google Calendar" link the human applies themselves |
| **gcalcli** (advanced) | power users | gcalcli's own OAuth | richer/multi-calendar read | optional direct write-back to Google |

Both tiers converge on **one** inbound upsert and **one** export path — the tier
only changes the *source adapter* and whether write-back is available. No
parallel pipelines.

---

## 1. Inbound — Google → Unruh (mechanical)

### 1.1 The shared contract: a normalized event

Both adapters produce the same shape; Unruh maps that shape to a node. This is
the single seam — define it once, in Unruh, and never parse calendars in two
places.

```jsonc
{
  "uid":         "abc123@google.com",   // stable Google UID — the idempotency key
  "summary":     "Dentist",
  "start":       "2026-07-02T14:00:00Z", // ISO-8601 UTC
  "end":         "2026-07-02T14:45:00Z", // or null (open-ended)
  "all_day":     false,
  "recurrence":  { "freq": "weekly", "interval": 1, "byweekday": [2] }, // or null
  "location":    "12 High St",
  "description": "bring referral letter",
  "status":      "confirmed",            // or "cancelled"
  "last_modified": "2026-06-20T09:00:00Z"
}
```

### 1.2 Mapping to a node (in Unruh)

- `type = 'event'` (Google entries are appointments, not Proto-Familiar tasks).
- `when = start`, `end = end`, `label = summary`.
- `payload`:
  - `source: 'gcal'` — marks it externally-managed (legibility + reconcile scope).
  - `gcal_uid: uid` — the idempotency key.
  - `gcal_last_modified` — used to skip no-op updates.
  - `recurrence` — mapped RRULE (see 1.4).
  - `location`, `description`, `all_day` — carried for the formatter.
  - `needs_projection: true` — **set only on first insert** (§4).

### 1.3 Upsert = full-snapshot reconcile, keyed by `gcal_uid`

The iCal feed is a complete snapshot, so `gcal_ingest` reconciles the whole
gcal-sourced set in one shot:

- **uid not seen before** → `add_node`, set `needs_projection`, count as *new*.
- **uid exists, `last_modified` advanced** → update `when/end/label/payload`
  fields in place (keep the node id, keep any consequence edges the Familiar
  authored, keep `needs_projection` as-is). Count as *updated*.
- **uid exists, unchanged** → no-op.
- **`status: cancelled`, or a previously-seen uid absent from this snapshot** →
  the event was deleted in Google. Resolve the node `cancelled` (preferred:
  keeps the record + any consequence learning) — do **not** hard-delete. Count
  as *removed*.

> ⚠️ **Deletion reconcile fires ONLY on a confirmed-good full fetch.** A failed
> or empty fetch must be a no-op, never "the snapshot is empty, so cancel
> everything." This is the single most important robustness rule in the inbound
> path. gcalcli partial/windowed reads pass `reconcile_deletes: false` so they
> can't cancel events outside the window they fetched.

### 1.4 Recurrence (RRULE → `payload.recurrence`)

Map the subset `recurrence.js` already understands: `FREQ` →
`freq`, `INTERVAL` → `interval`, `BYDAY` → `byweekday` (MO=0…SU=6),
`BYSETPOS` → `bysetpos`. One recurring series = **one anchor node** (matches the
existing model; the JS expander handles occurrences and per-occurrence
resolution).

For RRULEs outside the supported subset (complex `BYMONTHDAY` sets, multiple
`BYxxx`, `EXDATE`-heavy series): **don't silently drop them.** Fall back to
importing the next *N* expanded instances as individual `event` nodes flagged
`payload.gcal_expanded: true`, and `log()` that the rule was too complex to map
as a series. (Decision point §6 — confirm N and the fallback.)

### 1.5 The source adapters (in Node — fetch only)

Network and secrets stay in Node, consistent with every other adapter
(websearch, the Discord token). Unruh stays pure parse-and-store (testable with
fixture `.ics` strings, no network in Python).

- **Link adapter:** `fetch(icalUrl)` → raw `.ics` text → `gcal_ingest(ics_text=…)`.
  Unruh parses VEVENTs → normalized events → upsert. (A small hand-rolled VEVENT
  parser avoids a Python dependency; an `.ics` is line-folded `KEY:VALUE` with
  `BEGIN/END:VEVENT` blocks. If a dependency is preferred, `icalendar` — decide
  in §6.)
- **gcalcli adapter:** spawn `gcalcli` (subprocess), normalize its output in Node
  → `gcal_ingest(events=[…])`. Same upsert. `reconcile_deletes:false` unless the
  read covers the full forward window.

### 1.6 The sync loop (`gcal-sync-loop.js`, Node)

A thin loop on the established singleton/supervisor pattern (mirror
`reachout-loop.js` / `memory-sweep-loop.js`):

- Ticks on an interval (propose ~15 min; the iCal feed is not real-time anyway).
- Reads the iCal URL / gcalcli config from settings; if neither configured, idles.
- Calls the source adapter → `gcal_ingest` → gets `{new, updated, removed}` node ids.
- Routes the `new` ids into the projection cue (§4).
- **Off-switch in the same commit:** env `PROTO_FAMILIAR_GCAL_DISABLED=1`
  **and** a Settings toggle ("Google Calendar sync"). A 30-s supervisor follows
  the toggle + URL the way the Discord supervisor does, so enabling/disabling
  applies without a restart.
- **Degrades silently:** a fetch error, a bad URL, a parse failure — logged
  loudly, never surfaced in chat, never touches other loops, never reconciles
  deletions (1.3).

---

## 2. Outbound — Unruh → human (deterministic, Familiar-initiated)

### 2.1 The export tool (the "Familiar never types the link" requirement)

A new Unruh MCP tool, e.g. `schedule_export(id)`, returns artifacts built **in
code from the node's stored fields**:

```jsonc
{
  "ok": true,
  "ics":        "BEGIN:VCALENDAR…BEGIN:VEVENT…END:VEVENT…END:VCALENDAR",
  "google_url": "https://calendar.google.com/calendar/render?action=TEMPLATE&text=Dentist&dates=20260702T140000Z/20260702T144500Z&details=…&location=…"
}
```

- The Familiar calls it with a node `id` from the `[schedule ids]` legend it
  already reads — and gets back a correct link/file. It never assembles the URL
  or the date math itself. (This is the entity-as-subject "operability" rule:
  every input the tool needs — just the `id` — is already in a surface the
  Familiar has.)
- **Source-independent:** export works on *any* Unruh node, even one the human
  added by hand with no Google config at all. It's "turn this into something I
  can put on my calendar," not "round-trip with Google." So it's always
  available, gated by nothing.

### 2.2 Delivery

- **Web chat:** expose `GET /api/schedule/:id/export.ics` (calls Unruh, streams
  the `.ics` as a download) so the Familiar's message can carry a real download
  link; the `google_url` is just a clickable link. The Familiar's tool result
  returns both; the UI renders them.
- **Discord:** attach the `.ics` file and/or post the `google_url`.
- Apply the standard outgoing sanitisation (`stripLlmTimestamps`) to anything
  the Familiar says around the link — the link/file itself is machine-built and
  exempt.

### 2.3 Advanced write-back (gcalcli tier, optional)

When gcalcli write is enabled, the same Familiar gesture ("put this on my
calendar") can fulfil by **directly creating the event in Google** via `gcalcli
add`, instead of handing over a link. Keep this an **explicit, separate**
capability from `schedule_export` (a distinct tool, e.g. `schedule_push_to_google`)
so it's always legible when the Familiar is touching the human's real calendar
vs. handing them an artifact to apply themselves. Write-back is the only place we
mutate Google; treat it like any outward-facing action (confirm unless durably
authorised). **Recommend shipping read + export first and adding write-back only
if wanted** — see §6.

---

## 3. The exact-values principle (why this is shaped the way it is)

State it in the spec because it's the reason for every "in Unruh, not in the
prompt" choice above:

> The Familiar is never the source of an exact string or number that has to be
> machine-correct. Dates, durations, UIDs, URLs, `.ics` bytes, RRULEs — all
> generated by Google or by Unruh's deterministic code. The Familiar references
> a node by `id` and *talks about* it; it never *constructs* the artifact.

This is the same principle behind stripping hallucinated `[HH:MM]` timestamps
and behind keeping the needs-lapse a code fact rather than an LLM judgment. It's
also the answer to the "LLMs are bad at math/certainty" concern: don't put the
model on the hook for values it can't reliably produce.

---

## 4. The projection prompt on new nodes — "and that's it"

When ingestion creates **new** nodes, the Familiar is prompted into the
**projection step only** — think two moves ahead and author both futures
(`on_resolve` + `on_lapse`) via `schedule_link`. No task-nagging, no care-check,
no "do this now." An ingested appointment is an event, not a Proto-Familiar
task, so it never enters the surface-candidates pipeline; the projection cue is
the *single* Familiar-facing consequence of ingestion.

### 4.1 Mechanism — ride an existing turn, gate in code

No new LLM request (CLAUDE.md "ride existing requests"). Pure-code selection
builds a focused injected block, rendered into the next chat turn the way the
deferred-intents / recent-ponderings blocks already are:

- **Candidate set (code-gated):** gcal-sourced nodes with `needs_projection:true`,
  bounded to an upcoming horizon (propose next 14 days) and capped per turn (so a
  100-event import can't flood the cue). One series = one prompt (the anchor node).
- **The block (first-person, anchored to identity):**
  > *New on {{user}}'s calendar, not yet thought through:*
  > *— Dentist, Thu Jul 2 2:00pm  [id: …]*
  > *I think two moves ahead: what does each lead to if it resolves, and if it
  > lapses? I record both with `schedule_link`. Then I'm done with it — these
  > are appointments, I don't otherwise chase them.*

  (Wording is illustrative; follow the proactivity rules — name the value of
  projecting, no bias language, anchor to the Familiar's own voice.)

### 4.2 Clearing the flag

- **Auto-clear (pure derivation, preferred):** once the node has ≥1 outgoing
  consequence edge (`causes` / `co_occurs_with`), it's been thought through →
  drop it from the candidate set. No bookkeeping tool needed.
- **Explicit skip:** also let the Familiar mark "nothing worth projecting here"
  so trivia (a 15-min standup) doesn't resurface forever — reuse the
  `acknowledge_deferred_intent`-style pattern, or a tiny `schedule_mark_projected(id)`.
  Mirror floating-task aging: cap how many times an un-projected item resurfaces
  before it goes quiet on its own.

> ⚠️ Avoid the recorded "acknowledge ≠ acting" trap (CLAUDE.md error #2): the
> clear step must not *look* like the deliverable. The deliverable is the
> `schedule_link` calls; clearing is a consequence of having made them. Don't
> word the cue so the Familiar can satisfy it by calling the skip tool without
> projecting.

---

## 5. Legibility — the Familiar must know which items are Google's

A gcal-sourced node is externally managed: its `when`/`label` will be
**overwritten on the next sync**, and it's deleted in Google → cancelled here.
So the Familiar has to be able to tell.

- Render gcal-sourced items in `[Temporal Context]` with a marker (e.g. a 📅 or
  "(from Google)") via `temporal-format.js`.
- Make clear (tool descriptions / the marker's meaning) that the Familiar
  **should not edit a gcal node's core fields** (a local edit loses on the next
  reconcile) and **should not** `schedule_resolve` it as if it were a task — but
  **may and should** attach consequence edges (those are Proto-Familiar-side,
  never written back to Google, never overwritten).
- Export and projection are the two things the Familiar *does* with these items.

---

## 6. Decisions to confirm (flagged for the human)

These are genuine forks — I made a recommendation but want sign-off:

1. **"gcalcli" vs the literal "gogcli" you wrote.** I've specced against
   **gcalcli** (the established Google Calendar CLI). If you meant a different
   tool, say which and I'll re-target the advanced adapter.
2. **Write-back (§2.3).** Recommend shipping **read + export-link/file first**,
   adding direct gcalcli write-back as a later opt-in pass (it's the only path
   that mutates your real calendar). OK to defer?
3. **Fetch location.** Recommend **Node fetches bytes, Unruh parses + upserts**
   (keeps secrets/network where every other adapter lives, keeps Unruh
   network-free and unit-testable). Alternative: Unruh fetches the URL itself
   ("most literally within Unruh"). Your call.
4. **iCal parser.** Hand-rolled VEVENT parser (zero new dependency) vs the
   `icalendar` Python package (handles edge cases, adds a dep). Recommend
   hand-rolled for the common subset + fallback (1.4); revisit if real feeds
   break it.
5. **Recurrence fallback N** (1.4) and **sync interval** (1.6, proposed 15 min).
6. **Projection horizon / per-turn cap** (4.1, proposed 14 days).

---

## 7. Build order (suggested passes, all under 0.8)

1. **Inbound link tier:** normalized-event contract + Unruh `gcal_ingest`
   (parse + UID upsert + reconcile) with fixture-`.ics` tests; the Node link
   adapter + `gcal-sync-loop.js` + off-switch + Settings toggle; `source:'gcal'`
   legibility in the formatter.
2. **Outbound export:** Unruh `schedule_export` (+ tests on the generated
   `.ics`/URL), the download endpoint, thalamus wrapper, the Familiar-facing
   tool in cerebellum (first-person description), Discord delivery.
3. **Projection cue:** the code-gated candidate selector + injected block +
   auto-clear/skip; wire the loop's `new` ids into it.
4. **gcalcli tier (advanced):** the gcalcli read adapter (same upsert), Settings
   gate, gcalcli-installed detection.
5. **(Optional) write-back:** `schedule_push_to_google` via gcalcli add, explicit
   + confirmed.

Each pass: tests alongside, `docs/architecture.md` updated in the same commit,
off-switches shipped with their loops, no version bump until the milestone lands
as `0.8.0-alpha`.

---

## 8. What stays out of scope

- Two-way *sync* of arbitrary edits (we read Google; we don't push our edits back
  except the explicit write-back gesture). Unruh is not trying to be a calendar
  server.
- Non-Google providers. The normalized-event seam (1.1) means an Outlook/CalDAV
  adapter could slot in later behind the same `gcal_ingest`, but that's not this
  milestone.
- Familiar-driven *editing* of Google events. It references and exports; it
  doesn't reschedule the human's dentist appointment in Google.
