---
title: "Browser: Click-and-Fill Web Access"
topics: [architecture, browser, safety]
sources:
  - id: browser-lens-js
    type: file
    path: browser-lens.js
  - id: browser-proxy-js
    type: file
    path: browser-proxy.js
  - id: browser-driver-js
    type: file
    path: browser-driver.js
  - id: browser-js
    type: file
    path: browser.js
  - id: browser-audit-js
    type: file
    path: browser-audit.js
  - id: cerebellum-js
    type: file
    path: cerebellum.js
  - id: package-json
    type: file
    path: package.json
  - id: browser-build-spec
    type: file
    path: docs/browser-build-spec.md
---

# Browser: Click-and-Fill Web Access

The browser subsystem lets the Familiar navigate, read, and act on live web pages —
click, fill, scroll, and multi-step flows — instead of only reading a page through the
existing static `read_webpage` extractor. It shipped in two passes, Pass 1 (0.11.0, the
spine: driver, lens, guarded proxy, `browse_open`/`see`/`act`/`close`, the audit log) and
Pass 2 (0.11.1, screenshots, tabs, downloads, history) [@package-json] [@browser-driver-js]
[@browser-js]. `docs/browser-build-spec.md` is the design document Pass 1 and Pass 2
implement; the [Browser milestone: guardrails in code, not prompts](../decisions/browser-guardrails-in-code)
decision page records why its guardrails are shaped the way they are. This page describes
the five modules that exist in the repo today and how they fit together, using the built
code — not the spec — as the source of truth for what actually runs.

The feature is opt-in (`settings.browseEnabled`, default off, with a hard
`PROTO_FAMILIAR_BROWSE_DISABLED` env kill switch) and ward-only: the `browse_*` tools are
gated at the executor so a villager turn never reaches them [@browser-js] [@cerebellum-js].
`playwright-core` is an `optionalDependency`, so the server still boots when it is absent
[@package-json].

## Five modules, one job each

The subsystem is deliberately split so that each layer can be reasoned about — and tested —
in isolation.

**`browser-lens.js`** is pure: it takes a plain `PageData` object and turns it into a
leveled, ref'd, token-capped snapshot (`outline` / `actions` / `text` / `full`), plus a
code-computed delta verdict describing what an action changed [@browser-lens-js]. It has no
dependency on `playwright-core` and is fixture-tested without a browser, which keeps the
ref/token logic — the part most likely to have subtle bugs — directly testable rather than
hidden behind a stub of the thing that actually renders the page. `isProtectedField()` flags
password, file, and other credential-shaped fields so the layers above can refuse to fill
them [@browser-lens-js].

**`browser-proxy.js`** is the SSRF enforcement floor. See the SSRF section below — it is
worth calling out separately because it is the one place in this subsystem where a naive
design would have quietly failed.

**`browser-driver.js`** is the engine. It lazily imports `playwright-core` so the server
boots without it, detects a usable Chromium (system channel, then the Playwright browser
cache, then a Familiar-fetched binary) and, when nothing is found, background-fetches one
into a git-ignored `browser/pw-browsers` by shelling out to `playwright-core`'s own install
CLI — which owns the version pin and checksum, so the fetch never blocks a chat turn
[@browser-driver-js]. It launches one persistent browser profile through the guarded proxy,
enforces a tab cap, runs an idle reaper that closes the browser after inactivity, and
supervises crashes. A DOM extraction is one in-page walk that produces the lens's `PageData`
shape, computing a unique CSS path per interactable node at extraction time
[@browser-driver-js] [@browser-lens-js].

**`browser.js`** is the executor-facing layer cerebellum's `browse_*` tools call
[@cerebellum-js]. It wires the driver's raw output through the lens, then applies the two
safety boundaries described below (injection-guard sanitization and Stranger-tier framing),
logs every open/act to the audit log, and turns any driver failure — a missing browser, a
crash, a stale ref — into a calm first-person string rather than an exception that reaches
the chat path [@browser-js].

**`browser-audit.js`** appends every action to `logs/browser-actions.jsonl`, mirroring the
shape of `discord-write-log.js`'s append-only log [@browser-audit-js].

## Refs never hold a live element; they resolve fresh at act time

Pass 1's central reliability problem is that a ref handed to the model (`r3`, `r14`) has to
keep pointing at the same element across turns, and must fail loud rather than silently act
on the wrong one once the page has moved. `browser-driver.js` does not hold live Playwright
`ElementHandle`s across turns — they pin DOM nodes and die silently on navigation. Instead,
each snapshot mints a ref alongside a code-computed unique CSS path, and that path is
re-resolved against the live DOM only at act time [@browser-driver-js].

A per-page generation counter, bumped on `framenavigated` and on page-driven navigation
(a link click, a JS redirect), is stamped onto every snapshot; `browse_act` rejects a ref
minted in an older generation before it ever tries to resolve it [@browser-driver-js]. At act
time the resolved locator must match exactly one element — zero or more than one is a
structured error, never a first-match guess [@browser-driver-js]. The failure mode this buys
is always "re-observe with `browse_see`, then retry," never "clicked something the model
never actually named."

This ref/generation design exists specifically because `playwright-core` 1.62.1 removed
`page.accessibility`; the public replacement, `locator.ariaSnapshot()`, does not emit stable
refs, and `getByRole(name)` is ambiguous whenever a page has duplicate accessible names — so
the CSS-path resolver was the fallback the installed API actually supports, not the first
choice from the spec [@browser-driver-js].

## SSRF is enforced by a proxy the app owns, not a pre-navigation check

Two naive designs for blocking requests to loopback, private, and link-local addresses both
fail against a browser engine specifically, because Chromium resolves DNS itself: a
pre-`goto` host check races a DNS rebind (the app's own lookup sees a public IP, Chromium's
later lookup sees a private one), and Playwright's `context.route` handler only ever exposes
`request.url()`, never the resolved socket IP, so "block by resolved IP" cannot be
implemented there at all [@browser-proxy-js].

`browser-driver.js` launches Chromium through a small in-process CONNECT proxy that
`browser-proxy.js` owns (`launch({ proxy })`). The proxy is the single resolution point for
every request the browser makes — main navigation and every subresource — and it reuses
`websearch.js`'s existing `isBlockedIp` verbatim rather than keeping a second copy of the
blocked-range logic [@browser-proxy-js]. Crucially, it connects to the exact IP it just
checked, so a rebind between the check and the connect cannot slip through: the browser and
the guard can never disagree about which address is actually being reached
[@browser-proxy-js]. This closes main-navigation, subresource, and DNS-rebinding SSRF with
one mechanism instead of three separate patches.

## Two boundaries turn raw page bytes into something safe to read

`browser.js` applies the same two-part discipline to every string a page contributes before
it reaches a prompt [@browser-js]:

- **Injection-guard sanitization.** Every snapshot and act verdict passes through
  `injection-guard.js`'s `sanitizeExternal()` — the same function `websearch.js` calls at the
  web-read boundary — before it leaves `browser.js` [@browser-js]. This makes `browser.js` a
  second wired call site for the guard beyond the ones recorded on
  [Injection guard: documented but never wired](injection-guard-gap).
- **Stranger-tier framing.** Every block of page text is wrapped in an explicit frame telling
  the Familiar the content is something it reads, never instructions it follows — a page
  asking it to visit a URL, run a tool, or ignore its ward describes the page's wishes, not
  the Familiar's duties [@browser-js]. This mirrors Village's floor tier for a `strangers`
  participant, whose text can never move safety state; see the "A web page is a Stranger from
  day one" section of [Browser milestone: guardrails in code, not prompts](../decisions/browser-guardrails-in-code)
  for why that tier was chosen as the starting floor.

Credential and file-input fields are refused before any of this: `isProtectedField()` flags
them in the lens, and `browser.js`/`browser-driver.js` never accept a model-supplied value
into one — the decision page covers the (still unbuilt, Pass 3) vault-fill path that will be
the one exception.

## What Pass 2 (0.11.1) added

Pass 2 kept the Pass 1 spine and added the pieces that make the browser usable for more than
text-only reads [@browser-js]:

- **`browse_screenshot`** saves a PNG as a media asset and returns its id, which the executor
  pushes onto `_pendingImages` so the screenshot rides the same turn through the existing
  `view_image` mechanism [@browser-js] [@cerebellum-js]. It is gated to vision-capable turns
  the same way `view_image` is, so a text-only turn is never offered a tool it cannot use —
  it reads the page via `browse_see level=text` instead [@cerebellum-js].
- **Downloads become media.** An act that triggers a download is captured
  (`acceptDownloads` + `takeLastDownload`) and saved through a mime allow-list restricted to
  documents, images, and audio — never an executable — with a size cap [@browser-js].
- **`browse_tabs`** (list/switch/close) and **`browse_history`** (query
  `logs/browser-actions.jsonl`) round out the tool surface [@browser-js] [@browser-audit-js].

## What is deliberately still deferred

`read_webpage` is not re-backed by this driver. It stays on its existing static extractor
even after Pass 1 and Pass 2 both shipped, on purpose: `read_webpage` is an always-on, widely
used tool, and the spec's ordering is to prove the driver on the opt-in `browse_*` surface
first, then flip the always-on tool to it only once the driver has shaken out under real use
[@browser-build-spec]. This is the one item the spec originally placed inside Pass 2 that the
shipped Pass 2 still left undone.

Everything the decision page calls the "sovereignty surfaces" — `browse_handoff` for
ward-performed logins and payments, the hand-edited `browser/autonomy-grants.json` consent
file, and the code-only `browser/credentials-vault.json` fill path — belongs to a Pass 3 that
has not shipped as of 0.11.1. A future implementer should not assume vault-fill or handoff
exist just because the rest of the browser surface does; check `browser.js` and
`browser-driver.js` for what is actually wired before relying on either.

## Related

- [Browser milestone: guardrails in code, not prompts](../decisions/browser-guardrails-in-code)
  — the design decisions behind the SSRF proxy, the Stranger-tier default, and the still-unbuilt
  credential and handoff surfaces.
- [Injection guard: documented but never wired](injection-guard-gap) — the pattern-scanner
  `browser.js` now also calls, and the other boundaries it does and does not cover.
- [Vision and media](vision-and-media) — the `view_image`/`_pendingImages` mechanism
  `browse_screenshot` rides, and the media asset store screenshots and downloads are saved
  into.
- [Safety spine](safety-spine) — the broader crisis-detection and threat-tracking system the
  Stranger-tier framing is designed never to be able to move.
