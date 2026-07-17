#!/usr/bin/env node
/**
 * UI walk — screenshot EVERY modal, tab, and view at phone size.
 *
 * This exists because sampled verification misses panes nobody touched:
 * the graph-map mobile bug shipped because "the modals are responsive"
 * was checked on a few panes and extrapolated to the rest. This script
 * makes the exhaustive sweep repeatable — run it after any UI change,
 * then LOOK at the shots (docs/ui-ux-guidelines.md "Testing changes").
 *
 * Usage:
 *   node scripts/ui-walk.mjs [--url http://127.0.0.1:8742] [--out ui-walk-shots]
 *
 * Requires playwright-core + a Chromium (CHROME env var, or the
 * Playwright default). Serves nothing itself — point it at a running
 * server, or a static server over public/ for layout-only checks
 * (API-dependent panes will show their error states; that's fine, the
 * layout is what's being reviewed).
 */
import { chromium, devices } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const URL = arg('--url', 'http://127.0.0.1:8742');
const OUT = arg('--out', 'ui-walk-shots');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME || undefined,
  args: ['--no-sandbox'],
});
const ctx = await browser.newContext({ ...devices['iPhone 12'] });
const page = await ctx.newPage();
const problems = [];
page.on('pageerror', e => problems.push(`pageerror: ${String(e).slice(0, 120)}`));

await page.goto(URL, { waitUntil: 'domcontentloaded' }).catch(e => { console.error(`Cannot reach ${URL}: ${e.message}`); process.exit(1); });
await page.waitForTimeout(800);

let count = 0;
const shot = async (name) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${String(++count).padStart(2, '0')}-${name}.png` });
  // Horizontal overflow is always a defect — flag it per state.
  const over = await page.evaluate(() =>
    document.scrollingElement.scrollWidth - window.innerWidth);
  if (over > 1) problems.push(`${name}: horizontal overflow ${over}px`);
};
const js = (code) => page.evaluate(code).catch(e => problems.push(`${code.slice(0, 40)}…: ${String(e).slice(0, 80)}`));

// Base chat + sidebar states
await shot('chat');
await js(`document.getElementById('sidebar').classList.add('mobile-open')`);
await shot('sidebar-menu');
await js(`openSidebarSection('section-connection')`);
await shot('sidebar-section-open');
await js(`closeSidebarSection(); document.getElementById('sidebar').classList.remove('mobile-open')`);

// Knowledge editor — all tabs + graph views
await js(`document.getElementById('knowledge-modal').classList.remove('hidden')`);
for (const t of ['memories', 'coverage', 'graph', 'identity', 'remember', 'snapshots', 'sessions', 'prompts', 'behaviour']) {
  await js(`keSwitchTab('${t}')`);
  await shot(`ke-${t}`);
}
await js(`keSwitchTab('graph')`);
await js(`document.getElementById('ke-graph-split').classList.add('hidden'); document.getElementById('ke-graph-map').classList.remove('hidden')`);
await shot('ke-graph-map');
await js(`document.getElementById('knowledge-modal').classList.add('hidden')`);

// Temporal editor — all tabs + schedule views (real clicks for the view toggle)
await js(`document.getElementById('temporal-modal').classList.remove('hidden')`);
for (const t of ['interests', 'threat', 'ponderings', 'schedule', 'routine', 'handoff', 'automation', 'calendar', 'weather']) {
  await js(`teSwitchTab('${t}')`);
  await shot(`te-${t}`);
}
await js(`teSwitchTab('schedule')`);
await page.click('#te-sched-view-calendar').catch(() => {});
await shot('te-sched-calendar');
await page.click('#te-sched-view-map').catch(() => {});
await shot('te-sched-map');
await js(`document.getElementById('temporal-modal').classList.add('hidden')`);

// Village — all tabs
await js(`document.getElementById('village-modal').classList.remove('hidden')`);
for (const t of ['people', 'categories', 'locations', 'contacts']) {
  await js(`vlSwitchTab('${t}')`);
  await shot(`vl-${t}`);
}
await js(`document.getElementById('village-modal').classList.add('hidden')`);

// Standalone modals
for (const [id, name] of [
  ['connections-modal', 'connections'], ['tomes-modal', 'tomes'],
  ['websearch-modal', 'websearch'], ['prompt-inspector-modal', 'inspector'],
]) {
  const ok = await page.evaluate((mid) => {
    const el = document.getElementById(mid);
    if (!el) return false;
    el.classList.remove('hidden');
    return true;
  }, id).catch(() => false);
  if (!ok) { problems.push(`modal not found: ${id}`); continue; }
  await shot(name);
  await page.evaluate((mid) => document.getElementById(mid).classList.add('hidden'), id);
}

// Soft-keyboard simulation: shrink --app-h (what initMobileViewport
// writes from the visual viewport) and check that an open modal tracks
// it — if it doesn't, focused inputs hide behind the keyboard (the
// reported "typing under the keyboard" bug class).
await page.evaluate(() => {
  document.getElementById('knowledge-modal').classList.remove('hidden');
  document.documentElement.style.setProperty('--app-h', '380px');
});
await page.waitForTimeout(300);
const kb = await page.evaluate(() => ({
  modal: Math.round(document.getElementById('knowledge-modal-inner').getBoundingClientRect().height),
  backdrop: Math.round(document.getElementById('knowledge-modal').getBoundingClientRect().height),
}));
if (kb.modal > 385 || kb.backdrop > 385) {
  problems.push(`modal ignores soft keyboard: modal=${kb.modal}px backdrop=${kb.backdrop}px at --app-h:380px`);
}
await page.evaluate(() => {
  document.documentElement.style.removeProperty('--app-h');
  document.getElementById('knowledge-modal').classList.add('hidden');
});

// White-input sweep: unthemed native controls are the recurring bug class.
const white = await page.evaluate(() => {
  const bad = [];
  for (const el of document.querySelectorAll('input, select, textarea')) {
    const t = (el.getAttribute('type') || 'text').toLowerCase();
    if (['checkbox', 'radio', 'range', 'file', 'color', 'hidden'].includes(t)) continue;
    if (getComputedStyle(el).backgroundColor === 'rgb(255, 255, 255)') {
      bad.push(el.id || el.name || el.className || t);
    }
  }
  return bad;
});
if (white.length) problems.push(`unthemed (white) controls: ${white.join(', ')}`);

await browser.close();
console.log(`${count} screenshots → ${OUT}/`);
if (problems.length) {
  console.log('\nPROBLEMS FOUND:');
  for (const p of problems) console.log(`  - ${p}`);
  process.exitCode = 1;
} else {
  console.log('No automatic problems detected — now LOOK at the screenshots.');
}
