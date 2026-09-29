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
- [ ] src/discord/discord-emotes.js
- [ ] src/discord/discord-gateway.js
- [ ] src/discord/discord-gif-embeds.js
- [ ] src/discord/discord-menu-kit.js
- [ ] src/discord/discord-write-log.js
### src/gcal
- [ ] src/gcal/gcal-attribution.js
- [ ] src/gcal/gcal-google.js
- [ ] src/gcal/gcal-projection.js
- [ ] src/gcal/gcal-source.js
- [ ] src/gcal/gcal-sync-loop.js
- [ ] src/gcal/gcal-sync-status.js
### src/memory
- [ ] src/memory/content-regate-loop.js
- [ ] src/memory/content-regate.js
- [ ] src/memory/content-tags.js
- [ ] src/memory/graph-vocab.js
- [ ] src/memory/hippocampus.js
- [ ] src/memory/memorization.js
- [ ] src/memory/memory-coverage.js
- [ ] src/memory/memory-sweep-loop.js
- [ ] src/memory/recent-ponderings.js
### src/pondering
- [ ] src/pondering/interest-picker.js
- [x] src/pondering/ponder-research.js
- [ ] src/pondering/ponder-web-budget.js
- [ ] src/pondering/pondering-cadence.js
- [ ] src/pondering/pondering-consolidate.js
- [ ] src/pondering/pondering-loop.js
- [ ] src/pondering/pondering.js
- [ ] src/pondering/reflection-events.js
- [x] src/pondering/surface-context.js
- [ ] src/pondering/surface-events.js
### src/safety
- [ ] src/safety/care-check.js
- [ ] src/safety/contact-baselines.js
- [ ] src/safety/crisis-classifier.js
- [ ] src/safety/crisis-signals.js
- [ ] src/safety/memory-integrity.js
- [ ] src/safety/memory-quarantine.js
- [ ] src/safety/noticing-loop.js
- [ ] src/safety/noticing-outcomes.js
- [ ] src/safety/noticing.js
- [ ] src/safety/outbox.js
- [ ] src/safety/outgoing-filter.js
- [ ] src/safety/silence-triage-loop.js
- [ ] src/safety/spine-states.js
- [ ] src/safety/threat-tracker.js
- [ ] src/safety/wait-streak.js
### src/schedule
- [ ] src/schedule/active-hours.js
- [ ] src/schedule/day-segments.js
- [ ] src/schedule/event-alerts.js
- [ ] src/schedule/gauge-crisis.js
- [ ] src/schedule/gauge-escalation.js
- [ ] src/schedule/needs-tracking-loop.js
- [ ] src/schedule/needs-tracking.js
- [ ] src/schedule/recurrence.js
- [ ] src/schedule/reminders-loop.js
- [ ] src/schedule/routine-review.js
- [ ] src/schedule/schedule-availability.js
- [ ] src/schedule/stewardship.js
- [ ] src/schedule/temporal-format.js
- [ ] src/schedule/tracker-projection-loop.js
### src/search
- [ ] src/search/websearch-providers.js
- [ ] src/search/websearch.js
### src/server
- [ ] src/server/pid-file.js
### src/sessions
- [ ] src/sessions/last-activity.js
- [ ] src/sessions/log-import.js
- [ ] src/sessions/proactive-session.js
- [ ] src/sessions/prompt-capture.js
- [ ] src/sessions/session-bindings.js
- [ ] src/sessions/session-log.js
- [ ] src/sessions/session-search.js
### src/tomes
- [ ] src/tomes/manual-tome.js
- [ ] src/tomes/tome-graduation-loop.js
- [ ] src/tomes/tome-graduation.js
- [ ] src/tomes/tome-lore.js
- [ ] src/tomes/tome-macros.js
- [ ] src/tomes/tome-store.js
### src/tracker
- [ ] src/tracker/mood-threat.js
- [ ] src/tracker/offer-tracker.js
- [ ] src/tracker/tracker-cues.js
- [ ] src/tracker/tracker-projections.js
### src/util
- [x] src/util/json-state.js
### src/village
- [x] src/village/audience.js
- [ ] src/village/knocks.js
- [ ] src/village/village-card.js
- [ ] src/village/village-presence.js
- [ ] src/village/village-registry-json.js
- [ ] src/village/village.js
- [ ] src/village/villager-consent.js
### src/vision
- [ ] src/vision/gemini-file-api.js
- [ ] src/vision/media-retention-loop.js
- [ ] src/vision/media-retention.js
- [ ] src/vision/media.js
- [ ] src/vision/vision.js
- [ ] src/vision/zai-vision.js
### src/voice
- [ ] src/voice/audio-frame.js
- [ ] src/voice/audio-worker-current.js
- [ ] src/voice/audio-worker-host.js
- [ ] src/voice/audio-worker.mjs
- [ ] src/voice/call-engine.js
- [ ] src/voice/offline-asr-models.js
- [ ] src/voice/voice-audio-features.js
- [ ] src/voice/voice-audio-tags.js
- [ ] src/voice/voice-backend.js
- [ ] src/voice/voice-bench-run.js
- [ ] src/voice/voice-bench.js
- [ ] src/voice/voice-call-audience.js
- [ ] src/voice/voice-call-guard.js
- [ ] src/voice/voice-call-server.js
- [ ] src/voice/voice-call-sfx.js
- [ ] src/voice/voice-call-turn.js
- [ ] src/voice/voice-catalogue.js
- [ ] src/voice/voice-chat-turn.js
- [ ] src/voice/voice-clips.js
- [ ] src/voice/voice-diarize.js
- [ ] src/voice/voice-discord-adapter.js
- [ ] src/voice/voice-discord-server.js
- [ ] src/voice/voice-embedding.js
- [ ] src/voice/voice-enroll.js
- [ ] src/voice/voice-extract.js
- [ ] src/voice/voice-fetch.js
- [ ] src/voice/voice-footprint.js
- [ ] src/voice/voice-generation.js
- [ ] src/voice/voice-guest-watchdog.js
- [ ] src/voice/voice-models.js
- [ ] src/voice/voice-pin.js
- [ ] src/voice/voice-presence.js
- [ ] src/voice/voice-speech.js
- [ ] src/voice/voice-synthesize.js
- [ ] src/voice/voice-tagging.js
- [ ] src/voice/voice-transcribe.js
- [ ] src/voice/voice-web-adapter.js
- [ ] src/voice/voiceprints.js
- [ ] src/voice/voices.js
### src/ward
- [ ] src/ward/ward-connections.js
- [ ] src/ward/ward-consent-queue.js
### src/warmth
- [ ] src/warmth/reach-out-log.js
- [ ] src/warmth/reachout-loop.js
- [ ] src/warmth/reachout.js
- [ ] src/warmth/villager-context.js
### src/weather
- [ ] src/weather/weather-format.js
- [ ] src/weather/weather-mirror.js
- [ ] src/weather/weather-providers.js
- [ ] src/weather/weather-service.js
- [ ] src/weather/weather-source.js

## Node — public/ + scripts/
- [ ] public/app.js
- [ ] public/graph-map.js
- [ ] public/icons.js
- [ ] public/voice-call-capture-worklet.js
- [ ] public/voice-call.js
- [ ] public/voice-recorder.js
- [ ] scripts/_unruh-mcp.mjs
- [ ] scripts/audit-mcp-contracts.mjs
- [ ] scripts/audit-wiring.mjs
- [ ] scripts/build-prompt-catalog.mjs
- [ ] scripts/build-voice-catalogue.mjs
- [ ] scripts/chat-with-ponderings.mjs
- [ ] scripts/check-voice-ready.mjs
- [ ] scripts/ensure-audio-models.mjs
- [ ] scripts/ensure-node-deps.mjs
- [ ] scripts/ensure-phylactery-deps.mjs
- [ ] scripts/ensure-port-free.mjs
- [ ] scripts/ensure-unruh-deps.mjs
- [ ] scripts/ensure-voicebox.mjs
- [ ] scripts/import-entity.js
- [ ] scripts/import-tome.js
- [ ] scripts/lib/verify-python-peer.mjs
- [ ] scripts/migrate-domain.mjs
- [ ] scripts/pin-audio-models.mjs
- [ ] scripts/ponder-from-interests.mjs
- [ ] scripts/ponder-once.mjs
- [ ] scripts/pondering-loop-demo.mjs
- [ ] scripts/seed-test-interests.mjs
- [ ] scripts/threat-demo.mjs
- [ ] scripts/transcript-to-markdown.mjs
- [ ] scripts/ui-walk.mjs
- [ ] scripts/voice-bench.mjs
- [ ] scripts/voice-chunking-probe.mjs
- [ ] scripts/voice-clarity-probe.mjs
- [ ] scripts/voice-temperature-probe.mjs

## Python
- [ ] phylactery/src/phylactery/__init__.py
- [ ] phylactery/src/phylactery/__main__.py
- [ ] phylactery/src/phylactery/audience.py
- [ ] phylactery/src/phylactery/backup.py
- [ ] phylactery/src/phylactery/consolidate.py
- [ ] phylactery/src/phylactery/content_gate.py
- [ ] phylactery/src/phylactery/db.py
- [ ] phylactery/src/phylactery/embed.py
- [ ] phylactery/src/phylactery/graduation.py
- [ ] phylactery/src/phylactery/graph.py
- [ ] phylactery/src/phylactery/identity.py
- [ ] phylactery/src/phylactery/memory.py
- [ ] phylactery/src/phylactery/migrate_from_entity_core.py
- [ ] phylactery/src/phylactery/remember.py
- [ ] phylactery/src/phylactery/scheduler.py
- [ ] phylactery/src/phylactery/server.py
- [ ] phylactery/src/phylactery/snapshot.py
- [ ] phylactery/src/phylactery/village_registry.py
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
