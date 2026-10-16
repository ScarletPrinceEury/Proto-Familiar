---
title: "Stall resilience: no single await can wedge a room, a loop, or the server"
topics: [architecture, resilience, autonomous-loops, connections]
sources:
  - id: architecture-doc
    type: file
    path: docs/architecture.md
    note: "Turn deadlines (0.14.63), Provider-call deadlines (0.14.64), Stuck-tick watchdog (0.14.67), client disconnect and async-route crash containment (0.14.66/0.14.68)."
  - id: llm-call-js
    type: file
    path: llm-call.js
  - id: discord-gateway-js
    type: file
    path: src/discord/discord-gateway.js
  - id: tick-guard-js
    type: file
    path: src/util/tick-guard.js
  - id: upstream-abort-js
    type: file
    path: src/server/upstream-abort.js
  - id: async-routes-js
    type: file
    path: src/server/async-routes.js
  - id: server-js
    type: file
    path: server.js
  - id: discord-turn-deadline-test
    type: file
    path: tests/discord-turn-deadline.test.mjs
  - id: tick-guard-test
    type: file
    path: tests/tick-guard.test.mjs
  - id: upstream-abort-test
    type: file
    path: tests/upstream-abort.test.mjs
  - id: async-route-errors-test
    type: file
    path: tests/async-route-errors.test.mjs
---

# Stall resilience: no single await can wedge a room, a loop, or the server

Five fixes landed across 0.14.63-0.14.68 that all close the same underlying hole: an `await`
on a network call that never settles. A provider that answers with HTTP headers and then holds
the socket open with keep-alive bytes, never sending a body, defeats Node's own `fetch`
(undici) idle timeouts — a trickle of bytes resets them forever, so the request looks "alive"
indefinitely even though no useful answer is coming. Everything downstream of that fetch — a
Discord room's turn queue, a background loop's in-flight guard, an HTTP route's response — was
originally written to assume a call eventually settles, one way or another. It doesn't have to.
The five fixes bound that specific failure at each of the places it can wedge something real:
one Discord room, one autonomous loop, or (via an unrelated throw rather than a stall) the whole
server process [@architecture-doc].

This page exists because the fixes were paid for one surface at a time, discovered live rather
than designed in up front — the same pattern [Engineering conventions](../reference/engineering-conventions)
already names for RULE A/B/C. Read this page before adding a new call site that awaits a
network request, an MCP call, a tool, or a file lock inside a loop tick, a Discord turn, or an
HTTP handler: the bound you need probably already exists as a shared module, and copying the
unbounded shape is how this class of bug ships a sixth time.

## The shared failure shape

Every affected surface had the same two-part bug. First, the surface had a guard against doing
two things at once — Discord turns are serialized per location, an autonomous loop tracks
whether a tick is in flight — and that guard cleared only when the awaited work *settled*.
Second, nothing bounded how long that work could take, so a stalled provider call left the guard
held forever. The result in each case was the same: the surface went silent with no error,
because nothing ever threw — the request just never returned.

- **Discord**: turns are serialized per location by `enqueueTurn`, so an unbounded await in one
  turn holds every later message in that room unread until the process restarts [@discord-gateway-js].
- **Autonomous loops**: each of the fourteen loops in [Autonomous loops](autonomous-loops) guarded
  its tick with an in-flight flag that cleared on settle; a tick stuck on anything — a provider
  call, an MCP call, a tool, a file lock — stopped that loop for good, silently [@architecture-doc].
- **The HTTP server**: `/api/chat` and its sibling routes meant to stop a provider request when
  the client left, but the listener they used never fired (below), so a closed tab left the
  provider request running indefinitely, spending tokens against a trickling connection
  [@architecture-doc].

A fourth, related failure mode is not a stall at all but the opposite: an uncaught *throw*
(rather than a hang) inside an async Express route takes the whole process down. It is grouped
with the stall fixes here because the same audit pass that hardened the stall paths found it,
and because the fix (routes that cannot crash the server) protects the same chat and loop
surfaces the stall fixes protect.

## Discord turn deadlines

Discord turns are serialized per location so one room's conversation stays in order. Before
0.14.63-alpha, that queue had no deadline of its own: a provider that trickled keep-alive bytes
held the socket open past undici's 300-second idle timeout, the turn never settled, and every
later message in that DM or channel queued behind it unread — observable to the ward only as
"the Familiar stopped responding," with the status panel still reporting a healthy connection
and zero failures, because nothing had actually errored [@architecture-doc].

Three bounds now apply, named in `discord-gateway.js` [@discord-gateway-js]:

- `DISCORD_CALL_TIMEOUT_MS` (180s) bounds every individual provider round-trip inside a turn
  (`callChatRaw`'s `timeoutMs`/`signal`).
- `DISCORD_TURN_TIMEOUT_MS` (10 minutes) bounds the whole turn — every tool round and the
  outgoing-filter rewrite — via a signal `enqueueTurn` threads through the turn.
- Discord's own REST calls are bounded at 30 seconds.

A turn that respects its signal fails cleanly inside the deadline. A turn stuck in genuinely
non-cancellable work (most commonly a tool call that ignores the signal) cannot be force-killed —
JavaScript has no way to cancel an arbitrary in-flight `await` — so `enqueueTurn` instead
**abandons** it 20 seconds past the deadline: the location's queue is released so later messages
are read, the stuck turn's handle is marked `turn.abandoned`, and if the abandoned turn
eventually does finish, it checks that flag and drops its own reply rather than answering out of
order. This is the explicit tradeoff this whole page makes everywhere: nothing here *cancels*
slow work, it only ever stops *waiting* on it and marks the result as stale.

On expiry the ward gets an honest note on their own turn (quiet on villager/ambient turns, so a
guest's stalled turn does not narrate internals to them), the tool loop skips its plain-call
retry, and a timed-out outgoing-filter rewrite fails **closed** to the safe refusal rather than
letting an unfiltered reply through — the RULE B contract from
[Engineering conventions](../reference/engineering-conventions) ("budget exhaustion is never
silence") applied to a time budget instead of a token budget. Expiries log loudly and set
`status.lastError`, except a noticing-loop timeout, which is tagged with a `surface` marker kept
off the Discord gateway's own status so a background-loop timeout cannot read as a Discord
outage. `tests/discord-turn-deadline.test.mjs` crosses the real `fetch` boundary against a local
server that stalls exactly this way; four of its seven cases hang if the bound is removed
[@discord-turn-deadline-test].

## Provider-call deadlines

The Discord fix covered one call path. The same unbounded-fetch exposure sat underneath every
other LLM call site, because all of them (eventually) route through `callProviderChat` in
`llm-call.js` — see [Providers and connection readiness](providers) for how a saved connection
becomes an actual request. `callProviderChat` is now bounded **by default**: every call carries
a wall-clock deadline over both response headers and body (`PROVIDER_CALL_TIMEOUT_MS`, 300
seconds; `PROTO_FAMILIAR_LLM_CALL_TIMEOUT_MS` overrides it; only an explicit `0` opts out), plus
an optional caller-supplied `signal` for callers that need their own cancellation path on top
[@llm-call-js]. `deadlineSignal`/`isTimeoutError` are the one shared implementation underneath
both this default bound and the Discord turn deadlines above — the Discord path adopted them
rather than growing a second copy [@llm-call-js] [@discord-gateway-js].

300 seconds is a deliberate, not arbitrary, number: undici's own `headersTimeout` already kills
any genuinely non-responding call at 300s, so this bound never cuts off an answer that was
actually going to arrive — it only ever catches a socket that was trickling and was never going
to deliver. Before this fix, the affected call sites were every surface the "ride existing
requests" rule in [Engineering conventions](../reference/engineering-conventions) routes through
`callProviderChat`: pondering, warm reach-out, tome graduation, content re-gate, media
retention, page watch, and — because its image-describe step awaits a provider call first —
memorization. Each stood to stop its parent loop for good on a single stalled response.

Two safety-adjacent callers needed their own, narrower bounds instead of the shared default,
because each has its own fallback contract on expiry:

- Silence triage's deliberation call is bounded at 180 seconds; expiry keeps the safe default
  (`wait`), marks the attempt `failed` with the reason logged to the triage event log, and
  re-checks on the *next* tick rather than waiting out the tier cool-down — see
  [Safety spine](safety-spine).
- Noticing bounds each call at 180 seconds and the whole deliberation (every round plus every
  tool call) at 600 seconds; whatever already happened counts — a reach-out that went out before
  the timeout is still acted, otherwise the tick logs `deliberation_failed` with no change to the
  wait-streak counter described in [Autonomous loops](autonomous-loops).

## Stuck-tick watchdog

Bounding provider calls does not bound everything else a tick can await — an MCP call to
Phylactery or Unruh, a tool, a file lock. Before 0.14.67-alpha, every one of the fourteen
background loops in [Autonomous loops](autonomous-loops) carried its own hand-written copy of
the same in-flight guard (`if (_activeTick) return; … finally { _activeTick = null }`), and a
tick stuck on any unbounded wait — not just a provider call — stopped that loop for good with no
signal to anyone.

`src/util/tick-guard.js`'s `createTickGuard({ name, watchdogMs, onRelease })` replaces all
fourteen copies with one guard [@tick-guard-js]. It never lets two ticks of the same loop overlap
and hands a busy caller the already-in-flight tick. A tick still running after its own
`watchdogMs` is **released**: the release is logged loudly and counted, and the next tick is
allowed to run. Consistent with the Discord abandonment tradeoff above, the guard cannot actually
cancel the stuck tick — nothing can force-cancel an arbitrary `await` — so the old tick keeps
running in the background; its `tick` handle is marked `abandoned` and its `signal` aborted, so
any call inside it that honors the signal stops, and a side effect written after a release check
can see that the tick is stale. If the stuck tick eventually finishes anyway, that is logged too.
`settle()` — the function every loop's `stop*()` calls during shutdown — waits for an in-flight
tick but never past its own watchdog, so one stuck tick cannot hang a clean shutdown either.
`tickGuardStatus()` (running / started-at / release count / last-released-at, per loop) is
exposed on `GET /api/health` as `tickGuards`.

Each loop's watchdog is set well above its own longest *healthy* tick, because releasing a tick
that is merely slow (not stuck) lets the next one start and overlap it: 5 minutes for reminders;
10 minutes for memory sweep, tracker projections, silence triage, and needs tracking; 15 minutes
for warm reach-out, page watch, Google Calendar sync, and media retention; 20 minutes for
noticing; 30 minutes for pondering, tome graduation, and content re-gate; 60 minutes for
memorization (where a released job stays `processing` until boot recovery retries it, with the
job id logged). The two safety-adjacent loops — silence triage and noticing — report a release
through their own event logs (`tick_released`) rather than only the generic watchdog log, so a
stuck safety tick is visible in the same place its other decisions are, and the trusted-contact
escalation check still runs on a triage release. **A new loop must use this shared guard**,
picking its own watchdog the same way, rather than writing a fifteenth copy of the hand-rolled
flag. `tests/tick-guard.test.mjs` exercises the guard directly plus real reminders, reach-out,
triage, and noticing loops recovering from a tick that never settles [@tick-guard-test].

## Client disconnect, and routes that can't crash the server

`/api/chat` was written to abort its provider request when the ward's tab closed, listening on
`req.on('close')`. That listener never fires in practice: since Node 16, a request's `'close'`
event fires once its **body** has been fully read, which happens during `express.json()`
parsing, well before the route handler (where the listener was attached) ever runs. A closed
tab, a voice turn giving up, or an external OpenAI-compatible client hanging up therefore left
the provider request running to completion regardless — tokens spent, a socket held, potentially
forever against a trickling connection [@architecture-doc].

`src/server/upstream-abort.js`'s `clientDisconnectSignal(res)` is the fix: it listens on the
**response's** `'close'` event (checking `writableFinished` is still `false`), attached at the
very top of the handler before any `await`, which is the point that actually fires when the
other side leaves [@upstream-abort-js]. `upstreamSignal` combines that disconnect signal with the
shared 300-second deadline from `llm-call.js` for non-streaming requests; a streaming response
keeps only the disconnect signal, because a long stream is a legitimate, ward-visible thing to
wait on and the ward can stop it themselves. `upstreamFailure` classifies the result for the
ward: 499 if the client left, 504 if the deadline fired, 502 for any other network failure. Every
upstream fetch on `/api/chat` (tool-loop rounds, streaming rounds, the raw path, the
outgoing-filter rewrite), the `/v1/*` OpenAI-compatible endpoints (which carry the external
client's own disconnect through their loopback call), and `/api/video-understand`'s per-step
Gemini File API calls now carry this signal [@architecture-doc].

Fixing the disconnect listener surfaced a second, unrelated crash class while it was being
verified against the real route: several of the upstream body reads this fix touches sat outside
any `try` block, and Express 4 does not catch a promise rejected by an async route handler —
Node exits the whole process on an unhandled rejection. A provider dropping the connection
mid-reply on `/api/chat`'s raw path crashed the entire server, taking down every surface and
every loop with it, not just that one request. A second, narrower live instance was found while
checking this specifically: `POST /api/chat` with a `null` entry in its `messages` array crashed
the process on `m.role`, with no response ever sent.

That second crash class is not specific to upstream reads — **any** uncaught throw in any of
`server.js`'s roughly 200 async routes had the same effect [@server-js]. `src/server/async-routes.js`'s
`guardAsyncRoutes(app)`, called once right after `express()` and before any route is registered,
wraps every handler passed to `app.get/post/put/patch/delete/all` so a rejected handler's error
reaches `next(err)` instead of an unhandled rejection — including a reason-less `throw undefined`,
which still arrives as a real error rather than silently continuing [@async-routes-js].
`asyncRouteErrorHandler()`, registered last (after every route), answers the caller with
`{ error }` — using the thrown error's own 4xx/5xx status when it set one (for example the body
parser's 400/413), otherwise 500 — and logs the route and stack loudly; a response that had
already started streaming is ended rather than left hanging open. This is deliberately **not** a
process-wide `unhandledRejection` swallow, which would hide the underlying bug and still leave
the one request that hit it hanging with no reply ever sent. `/api/chat` and `/api/debug-prompt`
also now reject a malformed `messages` entry directly as a 400 (`malformedMessageIndex`), closing
the specific null-entry case found during verification. `tests/upstream-abort.test.mjs` and
`tests/async-route-errors.test.mjs` both cross real HTTP hops rather than mocking them — the
latter runs a fixture Express app in a child process to show a throwing route surviving under the
guard and killing a bare Express 4 app without it [@upstream-abort-test] [@async-route-errors-test].

## What this invariant requires of new code

A new call site that awaits anything inside a Discord turn, a background-loop tick, or an HTTP
route handler needs to answer three questions before it ships, not after an incident finds the
gap: what bounds this specific await (an existing shared deadline, or a new one modeled on
`deadlineSignal`); what happens to the surrounding guard (the location queue, the tick guard, the
client-disconnect signal) if the bound fires; and what the ward or the Familiar is told on
expiry, per RULE B in [Engineering conventions](../reference/engineering-conventions). None of
the five mechanisms above can truly cancel slow work — they only ever stop *waiting* on it and
mark the result stale — so a new unbounded await does not merely risk a slow response, it risks
silently wedging whatever serialized surface it runs inside of.

## Related

- [Autonomous loops](autonomous-loops) — the fourteen background workers the stuck-tick watchdog
  protects, and the shared reentrancy contract it replaced.
- [Providers and connection readiness](providers) — how a saved connection becomes the actual
  request that `callProviderChat`'s default deadline now bounds.
- [Safety spine](safety-spine) — silence triage's narrower 180-second call bound and its
  fail-safe-`wait` expiry behavior.
- [Engineering conventions](../reference/engineering-conventions) — RULE A/B/C, the "Graceful
  degradation" rule this whole page is an instance of, and the five-incident postmortem pattern
  these fixes continue.
