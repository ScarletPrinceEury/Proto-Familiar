---
title: "Settings sync: per-key revisions and one locked writer"
topics: [architecture, connections]
sources:
  - id: settings-write-js
    type: file
    path: settings-write.js
  - id: settings-merge-js
    type: file
    path: settings-merge.js
  - id: app-js
    type: file
    path: public/app.js
  - id: server-js
    type: file
    path: server.js
  - id: cerebellum-js
    type: file
    path: cerebellum.js
  - id: discord-gateway-js
    type: file
    path: src/discord/discord-gateway.js
---

# Settings sync: per-key revisions and one locked writer

`settings.json` is written from more places than it looks: the web settings UI, the Familiar's
own settings tools, the Discord ward console's `!connection` menu, and the voice connection
picker all PUT or patch it. `settings-write.js`'s `writeSettings` is the single locked writer
every one of those paths now goes through, and `settings.json` itself carries a per-key revision
counter (`_revisions`) that lets a stale page detect exactly which of its own keys are out of
date, rather than overwriting the whole file on every save [@settings-write-js].

## The incident: a stale whole-copy PUT wiped saved connections

Before this fix, a page that changed one setting pushed its **entire** cached copy of every
synced key back to the server. A tab opened before the connections feature existed, a phone
whose cache was weeks stale, or a page whose first settings push raced ahead of its own first
read of the server's copy, all held an old `connections` list — and the next save from any of
them overwrote the real list with that stale one, silently moving the ward back onto a connection
they had already replaced [@settings-write-js]. This is a sharper case of an earlier, related
incident the same file documents: `settings-merge.js`'s whole-body-PUT bug once dropped
`voiceTts` entirely because the browser did not yet know the key existed, sending a whole test
through the wrong voice backend [@settings-merge-js]. That earlier fix made the server preserve
any key the client did not mention (`mergeSettings`: silence means "no opinion," never
"destroy it," and a key is only deleted by an explicit `null`) [@settings-merge-js] — but it could
not by itself stop a page from actively re-sending a key it still *does* mention, just with a
value that is already stale. Per-key revisions are the fix for that remaining gap.

## Per-key revisions and the conflict/rebase loop

Every settings write bumps `_revisions[key]` for each key whose value actually changed, regardless
of which writer changed it [@settings-write-js]. A page sends only the keys it changed since its
own last read, each tagged with the revision it was based on (`base`); `writeSettings` compares
that base against the current on-disk revision for each key and refuses the whole write with a
409 `conflict` (naming exactly which keys) if any of them moved since [@settings-write-js]. A
request with no `base` at all is refused as 409 `stale-page` — a page still running old code that
would otherwise re-send its whole snapshot [@settings-write-js].

`public/app.js`'s `flushSettings` is the client side of this loop: on a 409 `conflict`, it merges
the server's current copy into its own state (`applyRemoteSettings`) and retries, up to three
attempts, rather than failing the save outright [@app-js]. `rebaseSettingValue` decides each
conflicted key: unchanged on this page since `base` → take the server's value; unchanged on the
server → keep this page's edit; changed on both sides → for most keys the local edit wins (a
fresh, deliberate change outranks an unrelated one), but `connections` specifically merges by id
instead of picking a side wholesale [@app-js]. `mergeConnectionsByIntent` diffs the local page's
connection list against the base it started from to infer intent — added, removed, or edited —
and replays that intent onto the server's current list, so a connection added on one device and a
connection edited on another both survive the same conflict instead of one clobbering the other
[@app-js]. Pages also refresh their whole settings copy from the server proactively, on tab
visibility change and every few minutes while a tab stays open, so a long-idle tab's `base`
rarely drifts far enough to need the merge path at all [@app-js].

## The write path itself: locked, atomic, and unreadable-safe

`writeSettings(patch, { base, maxBytes, file })` runs under a per-file promise-chain lock
(`withFileLock`) so two concurrent writers — the PUT route and, say, a Discord console patch
landing at the same moment — cannot interleave a read-modify-write and lose one of their updates
[@settings-write-js]. `patch` can be a function of the current on-disk settings specifically so a
caller can compute its new value from whatever is actually there under the lock, rather than from
a copy it read before acquiring it. The write itself is atomic (`.tmp` file, then `rename`), and a
`settings.json` that exists but fails to parse is never overwritten — writing the patch alone over
an unreadable file would blank every other setting, so the write is refused with code
`unreadable` instead [@settings-write-js]. `putSettings` is the pure decision function behind
`PUT /api/settings`; the server route itself is a thin adapter around it, which is what lets a
test drive the real conflict/stale-page/success logic directly rather than through HTTP
[@settings-write-js] [@server-js].

Server-side writers — `cerebellum.js`'s own settings tools, and `discord-gateway.js`'s ward-console
settings patches — call `writeSettings` unconditionally (no `base`), since they are not racing a
browser tab's stale cache the way a PUT from the web UI is; they still take the same lock and the
same atomic-write guarantee, so a server-side write and a browser PUT can never interleave either
[@cerebellum-js] [@discord-gateway-js].

## Related

- [Ward Discord console](ward-console) — the `!connection` menu that writes through this same
  locked path.
- [Providers and connection readiness](providers) — the `connections` array this page's
  conflict-merge logic specifically special-cases, and what a saved connection becomes at call time.
- [Engineering conventions](../reference/engineering-conventions) — the "no copy-paste of
  substantial logic" rule this fix is itself an instance of: `settings-store.js`'s shared reader
  and `settings-write.js`'s shared writer exist so no caller hand-rolls its own read-modify-write
  against `settings.json`.
