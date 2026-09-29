# Line-by-line audit — coverage checklist

Every source file, checked off as it is genuinely line-read. Findings land in
`codebase-audit-2026-09-pass2.md` (issues) and `optimization-audit-2026-09.md`
(optimization/clarity). `x` = line-read; blank = pending. Durable across resets.

## Node — root
- [x] cerebellum.js
- [x] core-prompts.js
- [x] entity-ref.js
- [x] guide-chat.js
- [x] injection-guard.js
- [x] llm-call.js
- [x] macros.js
- [x] mcp-reconnector.js
- [x] message-sanitize.mjs
- [x] name-field.js
- [x] organs.js
- [x] own-files.js
- [x] phylactery-result.js
- [x] provider-models.js
- [x] providers.js
- [x] relative-time.js
- [x] repo-root.js
- [x] server.js
- [x] settings-merge.js
- [x] settings-store.js
- [x] slug-ids.js
- [x] thalamus.js
- [x] tool-surfacing.js
- [x] updater.js

## Node — src/ (by dir)
### src/backup
- [x] src/backup/holistic-backup.js
### src/browser
- [x] src/browser/browser-audit.js
- [x] src/browser/browser-cdp-arm.js
- [x] src/browser/browser-driver.js
- [x] src/browser/browser-grants.js
- [x] src/browser/browser-lens.js
- [x] src/browser/browser-proxy.js
- [x] src/browser/browser.js
- [x] src/browser/cdp-launcher.js
- [x] src/browser/page-watch-loop.js
- [x] src/browser/page-watch.js
- [x] src/browser/reader-doctor.js
- [x] src/browser/reader-router.js
- [x] src/browser/reddit-reader.js
- [x] src/browser/web-fetch-util.js
### src/discord
- [x] src/discord/discord-emotes.js
- [x] src/discord/discord-gateway.js
- [x] src/discord/discord-gif-embeds.js
- [x] src/discord/discord-menu-kit.js
- [x] src/discord/discord-write-log.js
### src/gcal
- [x] src/gcal/gcal-attribution.js
- [x] src/gcal/gcal-google.js
- [x] src/gcal/gcal-projection.js
- [x] src/gcal/gcal-source.js
- [x] src/gcal/gcal-sync-loop.js
- [x] src/gcal/gcal-sync-status.js
### src/memory
- [x] src/memory/content-regate-loop.js
- [x] src/memory/content-regate.js
- [x] src/memory/content-tags.js
- [x] src/memory/graph-vocab.js
- [x] src/memory/hippocampus.js
- [x] src/memory/memorization.js
- [x] src/memory/memory-coverage.js
- [x] src/memory/memory-sweep-loop.js
- [x] src/memory/recent-ponderings.js
### src/pondering
- [x] src/pondering/interest-picker.js
- [x] src/pondering/ponder-research.js
- [x] src/pondering/ponder-web-budget.js
- [x] src/pondering/pondering-cadence.js
- [x] src/pondering/pondering-consolidate.js
- [x] src/pondering/pondering-loop.js
- [x] src/pondering/pondering.js
- [x] src/pondering/reflection-events.js
- [x] src/pondering/surface-context.js
- [x] src/pondering/surface-events.js
### src/safety
- [x] src/safety/care-check.js
- [x] src/safety/contact-baselines.js
- [x] src/safety/crisis-classifier.js
- [x] src/safety/crisis-signals.js
- [x] src/safety/memory-integrity.js
- [x] src/safety/memory-quarantine.js
- [x] src/safety/noticing-loop.js
- [x] src/safety/noticing-outcomes.js
- [x] src/safety/noticing.js
- [x] src/safety/outbox.js
- [x] src/safety/outgoing-filter.js
- [x] src/safety/silence-triage-loop.js
- [x] src/safety/spine-states.js
- [x] src/safety/threat-tracker.js
- [x] src/safety/wait-streak.js
### src/schedule
- [x] src/schedule/active-hours.js
- [x] src/schedule/day-segments.js
- [x] src/schedule/event-alerts.js
- [x] src/schedule/gauge-crisis.js
- [x] src/schedule/gauge-escalation.js
- [x] src/schedule/needs-tracking-loop.js
- [x] src/schedule/needs-tracking.js
- [x] src/schedule/recurrence.js
- [x] src/schedule/reminders-loop.js
- [x] src/schedule/routine-review.js
- [x] src/schedule/schedule-availability.js
- [x] src/schedule/stewardship.js
- [x] src/schedule/temporal-format.js
- [x] src/schedule/tracker-projection-loop.js
### src/search
- [x] src/search/websearch-providers.js
- [x] src/search/websearch.js
### src/server
- [x] src/server/pid-file.js
### src/sessions
- [x] src/sessions/last-activity.js
- [x] src/sessions/log-import.js
- [x] src/sessions/proactive-session.js
- [x] src/sessions/prompt-capture.js
- [x] src/sessions/session-bindings.js
- [x] src/sessions/session-log.js
- [x] src/sessions/session-search.js
### src/tomes
- [x] src/tomes/manual-tome.js
- [x] src/tomes/tome-graduation-loop.js
- [x] src/tomes/tome-graduation.js
- [x] src/tomes/tome-lore.js
- [x] src/tomes/tome-macros.js
- [x] src/tomes/tome-store.js
### src/tracker
- [x] src/tracker/mood-threat.js
- [x] src/tracker/offer-tracker.js
- [x] src/tracker/tracker-cues.js
- [x] src/tracker/tracker-projections.js
### src/util
- [x] src/util/json-state.js
### src/village
- [x] src/village/audience.js
- [x] src/village/knocks.js
- [x] src/village/village-card.js
- [x] src/village/village-presence.js
- [x] src/village/village-registry-json.js
- [x] src/village/village.js
- [x] src/village/villager-consent.js
### src/vision
- [x] src/vision/gemini-file-api.js
- [x] src/vision/media-retention-loop.js
- [x] src/vision/media-retention.js
- [x] src/vision/media.js
- [x] src/vision/vision.js
- [x] src/vision/zai-vision.js
### src/voice
- [x] src/voice/audio-frame.js
- [x] src/voice/audio-worker-current.js
- [x] src/voice/audio-worker-host.js
- [x] src/voice/audio-worker.mjs
- [x] src/voice/call-engine.js
- [x] src/voice/offline-asr-models.js
- [x] src/voice/voice-audio-features.js
- [x] src/voice/voice-audio-tags.js
- [x] src/voice/voice-backend.js
- [x] src/voice/voice-bench-run.js
- [x] src/voice/voice-bench.js
- [x] src/voice/voice-call-audience.js
- [x] src/voice/voice-call-guard.js
- [x] src/voice/voice-call-server.js
- [x] src/voice/voice-call-sfx.js
- [x] src/voice/voice-call-turn.js
- [x] src/voice/voice-catalogue.js
- [x] src/voice/voice-chat-turn.js
- [x] src/voice/voice-clips.js
- [x] src/voice/voice-diarize.js
- [x] src/voice/voice-discord-adapter.js
- [x] src/voice/voice-discord-server.js
- [x] src/voice/voice-embedding.js
- [x] src/voice/voice-enroll.js
- [x] src/voice/voice-extract.js
- [x] src/voice/voice-fetch.js
- [x] src/voice/voice-footprint.js
- [x] src/voice/voice-generation.js
- [x] src/voice/voice-guest-watchdog.js
- [x] src/voice/voice-models.js
- [x] src/voice/voice-pin.js
- [x] src/voice/voice-presence.js
- [x] src/voice/voice-speech.js
- [x] src/voice/voice-synthesize.js
- [x] src/voice/voice-tagging.js
- [x] src/voice/voice-transcribe.js
- [x] src/voice/voice-web-adapter.js
- [x] src/voice/voiceprints.js
- [x] src/voice/voices.js
### src/ward
- [x] src/ward/ward-connections.js
- [x] src/ward/ward-consent-queue.js
### src/warmth
- [x] src/warmth/reach-out-log.js
- [x] src/warmth/reachout-loop.js
- [x] src/warmth/reachout.js
- [x] src/warmth/villager-context.js
### src/weather
- [x] src/weather/weather-format.js
- [x] src/weather/weather-mirror.js
- [x] src/weather/weather-providers.js
- [x] src/weather/weather-service.js
- [x] src/weather/weather-source.js

## Node — public/ + scripts/
- [ ] public/app.js
- [ ] public/graph-map.js
- [ ] public/icons.js
- [ ] public/voice-call-capture-worklet.js
- [ ] public/voice-call.js
- [ ] public/voice-recorder.js
- [x] scripts/_unruh-mcp.mjs
- [x] scripts/audit-mcp-contracts.mjs
- [x] scripts/audit-wiring.mjs
- [x] scripts/build-prompt-catalog.mjs
- [x] scripts/build-voice-catalogue.mjs
- [x] scripts/chat-with-ponderings.mjs
- [x] scripts/check-voice-ready.mjs
- [x] scripts/ensure-audio-models.mjs
- [x] scripts/ensure-node-deps.mjs
- [x] scripts/ensure-phylactery-deps.mjs
- [x] scripts/ensure-port-free.mjs
- [x] scripts/ensure-unruh-deps.mjs
- [x] scripts/ensure-voicebox.mjs
- [x] scripts/import-entity.js
- [x] scripts/import-tome.js
- [x] scripts/lib/verify-python-peer.mjs
- [x] scripts/migrate-domain.mjs
- [x] scripts/pin-audio-models.mjs
- [x] scripts/ponder-from-interests.mjs
- [x] scripts/ponder-once.mjs
- [x] scripts/pondering-loop-demo.mjs
- [x] scripts/seed-test-interests.mjs
- [x] scripts/threat-demo.mjs
- [x] scripts/transcript-to-markdown.mjs
- [x] scripts/ui-walk.mjs
- [x] scripts/voice-bench.mjs
- [x] scripts/voice-chunking-probe.mjs
- [x] scripts/voice-clarity-probe.mjs
- [x] scripts/voice-temperature-probe.mjs

## Python
- [x] phylactery/src/phylactery/__init__.py
- [x] phylactery/src/phylactery/__main__.py
- [x] phylactery/src/phylactery/audience.py
- [x] phylactery/src/phylactery/backup.py
- [x] phylactery/src/phylactery/consolidate.py
- [x] phylactery/src/phylactery/content_gate.py
- [x] phylactery/src/phylactery/db.py
- [x] phylactery/src/phylactery/embed.py
- [x] phylactery/src/phylactery/graduation.py
- [x] phylactery/src/phylactery/graph.py
- [x] phylactery/src/phylactery/identity.py
- [x] phylactery/src/phylactery/memory.py
- [ ] phylactery/src/phylactery/migrate_from_entity_core.py
- [x] phylactery/src/phylactery/remember.py
- [x] phylactery/src/phylactery/scheduler.py
- [x] phylactery/src/phylactery/server.py
- [x] phylactery/src/phylactery/snapshot.py
- [x] phylactery/src/phylactery/village_registry.py
- [ ] unruh/src/unruh/__init__.py
- [ ] unruh/src/unruh/__main__.py
- [ ] unruh/src/unruh/db.py
- [ ] unruh/src/unruh/gcal.py
- [ ] unruh/src/unruh/handoff.py
- [ ] unruh/src/unruh/ical.py
- [ ] unruh/src/unruh/icalwrite.py
- [ ] unruh/src/unruh/intention.py
- [ ] unruh/src/unruh/interest.py
- [ ] unruh/src/unruh/location.py
- [ ] unruh/src/unruh/schedule.py
- [ ] unruh/src/unruh/seed.py
- [ ] unruh/src/unruh/server.py
- [ ] unruh/src/unruh/templates.py
- [ ] unruh/src/unruh/tracker.py
- [ ] unruh/src/unruh/tracker_projection.py

## public non-JS
- [ ] public/index.html
- [ ] public/style.css
