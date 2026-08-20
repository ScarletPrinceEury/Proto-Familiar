/**
 * browser-driver.js — the engine (docs/browser-build-spec.md §1–§2, §5.1, §7).
 *
 * Owns the playwright-core lifecycle: channel detection, the Familiar's own
 * persistent profile, the guarded SSRF proxy (browser-proxy.js) every request
 * flows through, a tab registry with a hard cap, an idle reaper, and crash
 * supervision. It extracts a plain PageData for the pure lens (browser-lens.js)
 * and performs acts under the §4.1 dialog / file-input / popup policy.
 *
 * Graceful degradation is absolute (CLAUDE.md): playwright-core is lazy-imported
 * so the server boots without it; if it (or a system/pre-fetched Chromium) is
 * missing, `ensureContext` throws a calm reason the tool layer turns into "my
 * browser isn't available" — nothing here ever throws into the chat path.
 *
 * The verified install (probed, not recalled): playwright-core 1.62.1 has NO
 * `page.accessibility`; refs resolve via a code-computed unique CSS path from a
 * single in-page DOM walk, then a Playwright locator with an act-time
 * unique-match-or-error check (§3.2). Kept minimal and mostly live-tested.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

import { createGuardedProxy } from './browser-proxy.js';
import { buildRefTable, isProtectedField } from './browser-lens.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.join(__dirname, 'browser', 'profile');
const PW_BROWSERS_DIR = path.join(__dirname, 'browser', 'pw-browsers');

export const BROWSE_MAX_TABS_DEFAULT = 3;
const NAV_TIMEOUT_MS = 15000;
const ACT_TIMEOUT_MS = 5000;

// ── Chromium discovery ────────────────────────────────────────────────────
// System channel first, then the Playwright browser cache (PLAYWRIGHT_BROWSERS_
// PATH or the default), then the Familiar-fetched binary under browser/. Locates
// what already exists; when nothing does, startChromiumFetch (below) pulls one.
export function findChromium() {
  const envExe = process.env.PROTO_FAMILIAR_CHROME || process.env.CHROME;
  if (envExe && fs.existsSync(envExe)) return envExe;
  const caches = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(__dirname, 'browser', 'pw-browsers'),
  ].filter(Boolean);
  for (const base of caches) {
    let entries = [];
    try { entries = fs.readdirSync(base); } catch { continue; }
    for (const d of entries) {
      for (const rel of ['chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe']) {
        const p = path.join(base, d, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  // Common system installs.
  for (const p of ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ── Auto-fetch (spec §2, §14.4) ─────────────────────────────────────────────
// When no browser is found, fetch a pinned Chromium into our own git-ignored
// browser/pw-browsers — reusing playwright-core's OWN install CLI (which owns
// the version pin + checksum; we don't reinvent either). It runs in the
// BACKGROUND: a 130 MB download must never block a chat turn, so the first
// browse call kicks it off and returns a calm "setting up" line; status()
// surfaces progress; a later call finds the browser ready. The `browseEnabled`
// toggle already gated us here, so the fetch is consented.
let install = { status: 'idle', startedAt: null, error: null };
export function chromiumInstallState() { return { ...install }; }

export function startChromiumFetch({ spawnFn = spawn, findFn = findChromium } = {}) {
  if (install.status === 'fetching') return install;         // already going
  if (findFn()) { install = { status: 'ready', startedAt: null, error: null }; return install; }
  install = { status: 'fetching', startedAt: Date.now(), error: null };
  let cli;
  try {
    // playwright-core's `exports` map blocks resolving ./cli.js directly, but
    // ./package.json resolves — cli.js is its sibling at the package root.
    const pkg = createRequire(import.meta.url).resolve('playwright-core/package.json');
    cli = path.join(path.dirname(pkg), 'cli.js');
    if (!fs.existsSync(cli)) throw new Error('cli.js missing');
  } catch (err) { install = { status: 'failed', startedAt: Date.now(), error: 'playwright-core not installed' }; return install; }
  try {
    fs.mkdirSync(PW_BROWSERS_DIR, { recursive: true });
    const child = spawnFn(process.execPath, [cli, 'install', 'chromium', '--no-progress'], {
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: PW_BROWSERS_DIR },
      stdio: 'ignore',
    });
    child.on('error', (err) => { install = { status: 'failed', startedAt: install.startedAt, error: err.message }; });
    child.on('close', (code) => {
      if (code === 0 && findFn()) install = { status: 'ready', startedAt: install.startedAt, error: null };
      else install = { status: 'failed', startedAt: install.startedAt, error: `install exited ${code}` };
    });
  } catch (err) {
    install = { status: 'failed', startedAt: install.startedAt, error: err.message };
  }
  return install;
}

// ── The single live context ───────────────────────────────────────────────
let state = null; // { context, proxy, tabs:Map, idleTimer, launchedAt, crashes:[] }

function clearIdle() { if (state?.idleTimer) { clearTimeout(state.idleTimer); state.idleTimer = null; } }
function armIdle(idleMs) {
  clearIdle();
  if (!state) return;
  state.idleTimer = setTimeout(() => { closeBrowser('idle'); }, idleMs);
  state.idleTimer.unref?.();
}

/** Lazy-launch (or reuse) the persistent context, wired through the guarded proxy. */
export async function ensureContext({ idleMs = 5 * 60 * 1000, maxTabs = BROWSE_MAX_TABS_DEFAULT, lookupFn, siteGuard } = {}) {
  if (state?.context) { if (siteGuard) state.siteGuard = siteGuard; armIdle(idleMs); return state; }

  const exe = findChromium();
  if (!exe) {
    // No browser yet — kick off (or continue) the background fetch and tell the
    // caller it's installing, rather than blocking the turn on a 130 MB download.
    startChromiumFetch();
    if (install.status === 'failed') throw new Error(`browser download failed: ${install.error}`);
    throw new Error('installing chromium');
  }

  let chromium;
  try { ({ chromium } = await import('playwright-core')); }
  catch { throw new Error('playwright-core is not installed'); }

  const proxy = createGuardedProxy({ lookupFn });
  const proxyPort = await proxy.listen();

  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  let context;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: true,
      executablePath: exe,
      viewport: { width: 1280, height: 800 },
      reducedMotion: 'reduce',
      acceptDownloads: true,   // §6: a download becomes a media asset
      // Every request the browser makes tunnels through our IP-checking proxy.
      proxy: { server: `http://127.0.0.1:${proxyPort}` },
    });
  } catch (err) {
    await proxy.close();
    throw new Error(`browser launch failed: ${err.message.split('\n')[0]}`);
  }
  context.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  context.setDefaultTimeout(ACT_TIMEOUT_MS);

  state = { context, proxy, exe, tabs: new Map(), idleTimer: null, launchedAt: Date.now(), crashes: [], maxTabs, siteGuard };

  // Site-mode enforcement on TOP-LEVEL navigations, including page-triggered
  // ones (§5.2): abort a main-frame document navigation whose host the ward's
  // site mode disallows. Subresources are untouched (the CONNECT proxy owns the
  // network floor); only the frame's own destination is gated here.
  await context.route('**/*', (route) => {
    try {
      const req = route.request();
      if (state?.siteGuard && req.isNavigationRequest() && !req.frame().parentFrame() && !state.siteGuard(req.url())) {
        state.blockedNav = (state.blockedNav || 0) + 1;
        return route.abort('blockedbyclient');
      }
    } catch {}
    return route.continue();
  });

  // Popup / new-tab capture (§4.1): every new page joins the SAME guarded
  // context (so it inherits the proxy) and counts against the cap; over-cap
  // pages are closed immediately rather than left ungoverned.
  context.on('page', (pg) => registerTab(pg));
  context.on('close', () => { state = null; }); // crash / teardown → next use relaunches

  for (const pg of context.pages()) registerTab(pg);
  if (state.tabs.size === 0) await newTab();
  armIdle(idleMs);
  return state;
}

let tabSeq = 0;
function registerTab(pg) {
  if (!state) return;
  if (state._ephemeralPending) { state._ephemeralPending = false; return; } // read_webpage's throwaway tab
  if (state.tabs.has(pg)) return;
  if (state.tabs.size >= state.maxTabs) { pg.close().catch(() => {}); return; }
  const id = `t${++tabSeq}`;
  state.tabs.set(pg, { id, current: state.tabs.size === 0 });
  pg.__pfGeneration = pg.__pfGeneration || 0;
  pg.on('crash', () => { state?.crashes.push(Date.now()); });
  pg.on('close', () => { state?.tabs.delete(pg); });
  // A page-driven navigation (a link, a JS redirect) bumps the generation too,
  // so refs minted before it go stale and force a re-observe (§3.2).
  pg.on('framenavigated', (frame) => { if (frame === pg.mainFrame()) pg.__pfGeneration = (pg.__pfGeneration || 0) + 1; });
  // A download the Familiar's act triggered (§6): hold the most-recent one for
  // browse.js to save as a media asset (size-capped, mime allow-list there).
  pg.on('download', (dl) => { if (state) state.lastDownload = dl; });
}

async function newTab() {
  const pg = await state.context.newPage();
  registerTab(pg);
  return pg;
}

function currentPage() {
  for (const [pg, meta] of state.tabs) if (meta.current) return pg;
  return [...state.tabs.keys()][0] || null;
}

// ── PageData extraction (one in-page DOM walk → the lens's shape) ───────────
// Runs in the browser. Returns interactables + structure with a code-computed
// unique CSS path per node (the act-time resolver). No page mutation.
const EXTRACT_FN = `() => {
  const uniqueCss = (el) => {
    if (el.id && document.querySelectorAll(CSS.escape ? '#' + CSS.escape(el.id) : '#' + el.id).length === 1)
      return '#' + (CSS.escape ? CSS.escape(el.id) : el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node.tagName.toLowerCase() !== 'html') {
      let sel = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const sibs = [...parent.children].filter(c => c.tagName === node.tagName);
        if (sibs.length > 1) sel += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')';
      }
      parts.unshift(sel);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };
  const roleOf = (el) => {
    const r = el.getAttribute('role'); if (r) return r;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'button' || t === 'submit' || t === 'reset') return 'button';
      return 'textbox';
    }
    return tag;
  };
  const nameOf = (el) => {
    const al = el.getAttribute('aria-label'); if (al) return al.trim();
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const t = lb.split(/\\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ').trim(); if (t) return t; }
    if (el.tagName.toLowerCase() === 'input') {
      const id = el.id; if (id) { const lab = document.querySelector('label[for="' + id + '"]'); if (lab) return lab.textContent.trim(); }
      if (el.placeholder) return el.placeholder.trim();
    }
    const txt = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    return txt.slice(0, 120) || el.getAttribute('title') || el.getAttribute('alt') || '';
  };
  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const interactableSel = 'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[contenteditable=""],[contenteditable=true],[tabindex]';
  const inVp = (el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth; };
  const sectionOf = (el) => {
    let n = el;
    while (n) {
      if (n.getAttribute && (n.getAttribute('role') === 'region' || n.tagName === 'SECTION' || n.getAttribute('aria-label'))) {
        const lab = n.getAttribute('aria-label'); if (lab) return lab.trim();
      }
      n = n.parentElement;
    }
    let p = el.previousElementSibling || el.parentElement;
    for (let i = 0; i < 6 && p; i++) { if (/^H[1-6]$/.test(p.tagName)) return p.textContent.replace(/\\s+/g,' ').trim().slice(0,60); p = p.previousElementSibling || p.parentElement; }
    return '';
  };
  const nodes = [];
  const seen = new Map();
  // Structure: headings + landmarks (for the outline skeleton).
  for (const h of document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=region],main,nav,header,footer')) {
    if (!visible(h)) continue;
    nodes.push({ role: roleOf(h), name: nameOf(h), tag: h.tagName.toLowerCase(), interactable: false, inViewport: inVp(h), landmark: /MAIN|NAV|HEADER|FOOTER/.test(h.tagName) });
  }
  for (const el of document.querySelectorAll(interactableSel)) {
    if (!visible(el)) continue;
    const role = roleOf(el), name = nameOf(el);
    const key = role + '|' + name;
    const nth = seen.get(key) || 0; seen.set(key, nth + 1);
    nodes.push({
      role, name, tag: el.tagName.toLowerCase(),
      type: el.getAttribute && el.getAttribute('type') ? el.getAttribute('type').toLowerCase() : null,
      autocomplete: el.getAttribute && el.getAttribute('autocomplete') || '',
      inputmode: el.getAttribute && el.getAttribute('inputmode') || '',
      interactable: true, inViewport: inVp(el), section: sectionOf(el), nth, css: uniqueCss(el),
    });
  }
  const main = document.querySelector('main') || document.body;
  const text = (main?.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 12000);
  return { url: location.href, title: document.title, nodes, text };
}`;

export async function extractPageData(page) {
  // EXTRACT_FN is a string arrow function; a string passed to evaluate is an
  // EXPRESSION, so invoke it as an IIFE rather than returning the function.
  const data = await page.evaluate(`(${EXTRACT_FN})()`);
  data.generation = page.__pfGeneration || 0;
  return data;
}

/** Snapshot the current tab into PageData + a ref table (shared with the lens). */
export async function snapshot() {
  const pg = currentPage();
  if (!pg) throw new Error('no open tab');
  const pageData = await extractPageData(pg);
  const refTable = buildRefTable(pageData);
  // Stamp the generation the refs were minted in; act() rejects a ref used
  // after the page has moved on (§3.2 generation guard).
  state.current = { page: pg, pageData, refTable, generation: pageData.generation };
  return state.current;
}

// ── Navigation & acts ──────────────────────────────────────────────────────
export async function navigate(url, opts) {
  await ensureContext(opts);
  const pg = currentPage();
  pg.__pfGeneration = (pg.__pfGeneration || 0) + 1;
  await pg.goto(url, { waitUntil: 'domcontentloaded' });
  return snapshot();
}

/**
 * Read one page's LIVE (JS-rendered) DOM as an HTML string, then throw the tab
 * away — the browser-backed read_webpage path (§0.1). Ephemeral: the tab is
 * exempt from the registry/cap and never becomes `current`, so it can't disturb
 * an in-flight browse task. With no `url`, reads the current tab instead.
 * Returns { html, url } or throws (the caller falls back to the static floor).
 */
export async function readPage(url, opts) {
  await ensureContext(opts);
  if (!url) {
    const pg = currentPage();
    if (!pg) throw new Error('no open tab to read');
    return { html: await pg.content(), url: pg.url() };
  }
  state._ephemeralPending = true;             // registerTab skips this one (no cap, no current)
  const pg = await state.context.newPage();
  state.tabs.delete(pg);                       // belt-and-suspenders if the event still registered it
  try {
    await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    return { html: await pg.content(), url: pg.url() };
  } finally {
    await pg.close().catch(() => {});
  }
}

/**
 * Perform an act on a ref. `onDialog` ('dismiss'|'accept') pre-authorises how a
 * confirm this act triggers is answered (§4.1); the accept is only honoured for
 * a benign, non-protected target — the caller (browser-tools) enforces the §5
 * gates before we get here. Returns { before, after, event, actedRef }.
 */
export async function act({ ref, action, value, onDialog = 'dismiss' }) {
  if (!state?.current) await snapshot();
  const { page: pg, refTable } = state.current;
  const entry = refTable.byRef.get(ref);
  if (!entry) return { error: `unknown ref ${ref} — browse_see to re-observe` };
  if ((action === 'fill') && (entry.protected || isProtectedField(entry.node))) {
    return { error: `${ref} is a protected field — I can't type into it` };
  }
  // Generation guard: the page moved under this ref (a nav / DOM rebuild since
  // the snapshot) → don't act on a possibly-different element, force a re-look.
  if ((pg.__pfGeneration || 0) !== state.current.generation) {
    return { error: `ref ${ref} is stale (the page changed) — browse_see to re-observe` };
  }
  const before = state.current.pageData;
  const locator = pg.locator(entry.node.css);
  const count = await locator.count().catch(() => 0);
  if (count !== 1) return { error: `ref ${ref} no longer resolves uniquely (page changed) — browse_see to re-observe` };

  // Dialog policy (§4.1): one-shot handler for a dialog THIS act raises.
  const event = {};
  const onDlg = (dialog) => {
    const type = dialog.type();
    let decision = 'dismissed';
    if (type === 'alert') { dialog.accept().catch(() => {}); decision = 'acknowledged'; }
    else if (type === 'beforeunload') { dialog.accept().catch(() => {}); decision = 'accepted'; }
    else if (type === 'confirm') {
      if (onDialog === 'accept') { dialog.accept().catch(() => {}); decision = 'accepted'; }
      else { dialog.dismiss().catch(() => {}); decision = 'dismissed'; }
    } else { dialog.dismiss().catch(() => {}); decision = 'dismissed'; } // prompt → dismiss
    event.dialog = { type, message: dialog.message(), handled: decision };
  };
  pg.on('dialog', onDlg);
  pg.__pfGeneration = (pg.__pfGeneration || 0);

  try {
    const el = locator.first();
    switch (action) {
      case 'click':  await el.click({ timeout: ACT_TIMEOUT_MS }); break;
      case 'fill':   await el.fill(String(value ?? ''), { timeout: ACT_TIMEOUT_MS }); break;
      case 'select': await el.selectOption(String(value ?? ''), { timeout: ACT_TIMEOUT_MS }); break;
      case 'press':  await el.press(String(value ?? 'Enter'), { timeout: ACT_TIMEOUT_MS }); break;
      case 'hover':  await el.hover({ timeout: ACT_TIMEOUT_MS }); break;
      case 'scroll': await el.scrollIntoViewIfNeeded({ timeout: ACT_TIMEOUT_MS }); break;
      default: pg.off('dialog', onDlg); return { error: `unknown action ${action}` };
    }
  } catch (err) {
    pg.off('dialog', onDlg);
    return { error: `couldn't ${action} ${ref}: ${err.message.split('\n')[0]}` };
  }
  await pg.waitForTimeout(150); // let a nav/DOM settle enough to diff
  pg.off('dialog', onDlg);
  const after = await snapshot();
  return { before, after: after.pageData, event, actedRef: ref, actionLabel: action };
}

/**
 * Screenshot the current tab (or one element when `scope` is a ref). Returns
 * { buffer, url, title } — a PNG the caller saves as a media asset (§6).
 */
export async function screenshot({ scope = null } = {}) {
  if (!state?.current) await snapshot();
  const { page: pg, refTable } = state.current;
  let buffer;
  if (scope) {
    const entry = refTable.byRef.get(scope);
    if (!entry) return { error: `unknown ref ${scope} — browse_see to re-observe` };
    const loc = pg.locator(entry.node.css);
    if ((await loc.count().catch(() => 0)) !== 1) return { error: `ref ${scope} no longer resolves uniquely — browse_see to re-observe` };
    buffer = await loc.first().screenshot({ timeout: ACT_TIMEOUT_MS });
  } else {
    buffer = await pg.screenshot({ fullPage: false });
  }
  return { buffer, url: pg.url(), title: await pg.title().catch(() => '') };
}

// ── Tabs (§4, browse_tabs) ──────────────────────────────────────────────────
export function listTabs() {
  if (!state) return [];
  return [...state.tabs.entries()].map(([pg, meta]) => ({
    id: meta.id, current: meta.current, url: pg.url(), title: pg.__pfTitle || '',
  }));
}
export async function tabsDetailed() {
  if (!state) return [];
  const out = [];
  for (const [pg, meta] of state.tabs) out.push({ id: meta.id, current: meta.current, url: pg.url(), title: await pg.title().catch(() => '') });
  return out;
}
export async function switchTab(id) {
  if (!state) return { error: 'no browser open' };
  let found = null;
  for (const [pg, meta] of state.tabs) { meta.current = (meta.id === id); if (meta.current) found = pg; }
  if (!found) return { error: `no tab ${id}` };
  await found.bringToFront().catch(() => {});
  state.current = null; // force a fresh snapshot of the newly-current tab
  return { ok: true, id };
}
export async function closeTab(id) {
  if (!state) return { error: 'no browser open' };
  for (const [pg, meta] of state.tabs) if (meta.id === id) { await pg.close().catch(() => {}); return { ok: true, id }; }
  return { error: `no tab ${id}` };
}

/** Take the most-recent completed download (bytes + name), or null. */
export async function takeLastDownload() {
  if (!state?.lastDownload) return null;
  const dl = state.lastDownload; state.lastDownload = null;
  try {
    const p = await dl.path();
    if (!p) return null;
    const buffer = fs.readFileSync(p);
    return { buffer, name: dl.suggestedFilename() };
  } catch { return null; }
}

export async function closeBrowser(reason = 'close') {
  if (!state) return { ok: true };
  clearIdle();
  const s = state; state = null;
  try { await s.context.close(); } catch {}
  try { await s.proxy.close(); } catch {}
  return { ok: true, reason };
}

/** Lifecycle status for GET /api/browser/status. */
export function status() {
  return {
    running: !!state?.context,
    launchedAt: state?.launchedAt ?? null,
    tabs: state ? state.tabs.size : 0,
    executable: state?.exe ?? findChromium(),
    proxyBlocked: state?.proxy?.stats?.().blocked ?? 0,
    recentCrashes: state ? state.crashes.filter(t => Date.now() - t < 60000).length : 0,
    install: chromiumInstallState(),
  };
}
