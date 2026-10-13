/**
 * page-read.js — reading one page as clean prose, by whichever door is open.
 *
 * The ladder: a site with its own registered reader first (Reddit's JSON/OAuth
 * API, or a fetch through my browser's logged-in context — its anti-bot wall
 * turns automated browser traffic away before anything renders), then the live
 * JS-rendered DOM in my browser, then the plain static fetch (the floor —
 * reading never depends on the browser being up). read_webpage runs the whole
 * ladder; browse_open's fallback runs it with `liveRead: false`, because the
 * browser is what just failed. Never throws: the floor returns a plain-words
 * failure string.
 *
 * The browser modules are dynamic-imported so this file (imported by
 * cerebellum) keeps the browser engine out of the static graph.
 */

import { readWebpage } from '../search/websearch.js';
import { browseEnabled } from './browse-gate.js';

export async function readPageText(url, { settings = {}, ctx = {}, liveRead = true, deps = {} } = {}) {
  const s = settings || {};
  if (process.env.PROTO_FAMILIAR_REDDIT_DISABLED !== '1' && s?.redditReaderEnabled !== false) {
    try {
      const rr = await import('./reddit-reader.js');
      if (rr.isRedditUrl(url)) {
        // On my human's own turn, offer the authenticated-browser-context fetch
        // (their real browser fingerprint + logged-in Reddit session) — the door
        // past Reddit's network-layer block. Never on a gated/villager turn: the
        // session is theirs. readReddit falls back to public/OAuth inside.
        const redditDeps = {};
        const wardTurn = !ctx?.audienceTag || ctx.audienceTag === 'ward-private';
        if (wardTurn && browseEnabled(s)) {
          try {
            const drv = await import('./browser-driver.js');
            redditDeps.contextFetch = (u, o) => drv.contextRequest(u, o);
          } catch { /* no browser → public/OAuth only */ }
        }
        const r = await rr.readReddit(url, { settings: s, deps: redditDeps });
        // A definitive Reddit-side block/auth outcome is surfaced honestly; only
        // an unrecognised page falls through to the general ladder.
        if (r.ok || r.hard) return r.text;
      }
    } catch { /* fall through to the normal read path */ }
  }
  // Live read (browser spec §0.1): when browsing is on + a browser exists + my
  // human hasn't pinned 'static', read the JS-rendered DOM. Any failure falls
  // through to the static floor.
  if (liveRead) {
    try {
      const b = await import('./browser.js');
      if (b.shouldBrowserRead(s)) {
        const res = await b.browseRead({ url }, { settings: s, sessionId: ctx?.sessionInfo?.sessionId ?? null });
        if (res?.ok) return res.text;
        // Site mode blocked it → honour the block; don't reach it via the floor.
        if (res?.blocked) return res.text;
      }
    } catch { /* fall through to static */ }
  }
  return readWebpage(url, s, deps);
}
