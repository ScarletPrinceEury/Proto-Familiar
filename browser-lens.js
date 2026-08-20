/**
 * browser-lens.js — the cognition layer over a page (docs/browser-build-spec.md §3).
 *
 * This is the token model, and it is deliberately PURE: it never imports
 * playwright, never touches a live browser. It operates on a plain snapshot
 * object the driver extracts from a page (an accessibility-tree walk flattened
 * to a node list) and turns it into the compact, ref'd views the Familiar reads
 * plus the delta verdicts an act returns. Because it's pure, every rule here is
 * unit-tested against fixture data without spawning Chromium (the spec's
 * testability claim, and the way root-cause #3 of the vision post-mortem —
 * "stubs test the caller, never the thing at the end of the route" — is avoided:
 * the lens IS the thing, and it's tested directly).
 *
 * The driver hands us a `PageData`:
 *   {
 *     url, title,
 *     generation,                     // bumped on nav / major DOM rebuild
 *     nodes: [ {
 *       role,            // ARIA role ('button', 'link', 'textbox', …)
 *       name,            // accessible name
 *       tag,             // lowercased tag ('input','a',…) — for field typing
 *       type,            // input type when tag==='input' ('password','file',…)
 *       interactable,    // clickable/fillable/etc.
 *       inViewport,      // visible in the current viewport
 *       section,         // nearest landmark/heading label, for grouping
 *       nth,             // 0-based index among same role+name (disambiguator)
 *     } ],
 *     text,              // readability-ish main-region prose (for text/full)
 *   }
 *
 * The lens mints `rN` refs (short, ephemeral — they die with the generation,
 * per the slug rule) and, alongside each, a REGENERATED locator descriptor
 * (role + name + nth) the driver re-resolves against the live DOM at act time.
 * We never hold ElementHandles across turns: they pin DOM nodes and die silently
 * on navigation (§3.2).
 */

// Hard token caps per level (§3.1). Caps are enforced by code — truncation is
// explicit, never a silent drop. Tokens are estimated cheaply (≈4 chars/token);
// exactness isn't the point, bounding the block is.
export const LEVEL_CAPS = { outline: 1200, actions: 800, text: 2000, full: 4000 };
const CHARS_PER_TOKEN = 4;

const estTokens = (s) => Math.ceil(s.length / CHARS_PER_TOKEN);

// Autocomplete tokens the HTML spec reserves for credentials + payment (§5.4,
// §5 item 3). A field asking the browser to autofill any of these is card/CVV/
// account-shaped by the site's OWN declaration — the strongest signal we get.
const PROTECTED_AUTOCOMPLETE = new Set([
  'current-password', 'new-password', 'one-time-code',
  'cc-number', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'cc-csc', 'cc-name', 'cc-type',
]);
const CREDENTIAL_NAME_RE = /\b(password|passcode|cvv|cvc|cvn|csc|card\s*(number|no)|cardnum|iban|sort\s*code|routing|account\s*number|security\s*code|social\s*security|\bssn\b)\b/i;

/** A field the Familiar must never be able to fill with model-supplied bytes (§5.4). */
export function isProtectedField(node) {
  if (!node) return false;
  if (node.tag === 'input' && node.type) {
    const t = String(node.type).toLowerCase();
    if (t === 'password' || t === 'file') return true;
  }
  // The site's own autofill declaration (autocomplete) is the strongest signal.
  const ac = String(node.autocomplete || '').toLowerCase().trim();
  if (ac) for (const tok of ac.split(/\s+/)) if (PROTECTED_AUTOCOMPLETE.has(tok)) return true;
  // A numeric-keypad field named like a card/CVV is payment-shaped too.
  const name = String(node.name || '').toLowerCase();
  if (CREDENTIAL_NAME_RE.test(name)) return true;
  const im = String(node.inputmode || '').toLowerCase();
  if ((im === 'numeric' || node.type === 'tel') && /\b(card|cvv|cvc|csc|cvn|security|iban)\b/.test(name)) return true;
  return false;
}

/**
 * Build the ref table: interactables only, in document order, each assigned a
 * stable-within-generation `rN` and a regenerated locator descriptor. Returns
 * { order: ['r1',…], byRef: Map<ref, {node, locator}> }.
 */
export function buildRefTable(pageData) {
  const order = [];
  const byRef = new Map();
  let n = 0;
  for (const node of pageData?.nodes ?? []) {
    if (!node?.interactable) continue;
    const ref = `r${++n}`;
    order.push(ref);
    byRef.set(ref, {
      node,
      // The locator the driver re-resolves at act time (§3.2): role + accessible
      // name + nth-of-(role,name). Code-minted; the model only ever repeats `ref`.
      locator: { role: node.role || null, name: node.name || '', nth: node.nth || 0 },
      protected: isProtectedField(node),
    });
  }
  return { order, byRef };
}

/** One dense ref line: `r14 button "Add to basket" (in: product card 'Oat milk')`. */
function refLine(ref, node) {
  const role = node.role || node.tag || 'element';
  const name = node.name ? ` "${node.name}"` : '';
  const where = node.section ? ` (in: ${node.section})` : '';
  const guard = isProtectedField(node) ? ' [protected — I can\'t fill this]' : '';
  return `${ref} ${role}${name}${where}${guard}`;
}

/** Non-interactable structure line for the outline skeleton (landmarks/headings). */
function structureLine(node) {
  const role = node.role || node.tag;
  return node.name ? `${role}: ${node.name}` : role;
}

/**
 * Render a snapshot at a level, capped. Returns { text, refTable, truncated }.
 * `scope` (a ref) narrows to that node's section — the cheap "watch one widget"
 * path (§3.1). Truncation is explicit with a continuation hint.
 */
export function renderSnapshot(pageData, { level = 'outline', scope = null } = {}) {
  const refTable = buildRefTable(pageData);
  const cap = LEVEL_CAPS[level] ?? LEVEL_CAPS.outline;
  const head = `${pageData?.title || '(untitled)'} — ${pageData?.url || '(no url)'}`;

  // Scope filter: keep only nodes in the same section as the scoped ref.
  let nodes = pageData?.nodes ?? [];
  let scopeNote = '';
  if (scope) {
    const entry = refTable.byRef.get(scope);
    if (!entry) {
      return { text: `${head}\n(unknown ref ${scope} — browse_see to re-observe)`, refTable, truncated: false };
    }
    const sect = entry.node.section;
    nodes = nodes.filter(nd => nd.section === sect);
    scopeNote = ` · scope: ${scope}`;
  }

  const wantStructure = level === 'outline' || level === 'full';
  const wantActions   = level === 'outline' || level === 'actions' || level === 'full';
  const wantText      = level === 'text'    || level === 'full';

  const lines = [`[page] ${head}${scopeNote}`];
  let refN = 0;
  const refFor = new Map(); // node → ref, so lines and the table agree
  for (const ref of refTable.order) refFor.set(refTable.byRef.get(ref).node, ref);

  if (wantStructure) {
    const struct = nodes.filter(nd => !nd.interactable && (nd.role === 'heading' || nd.landmark || nd.role === 'region'));
    for (const nd of struct.slice(0, 40)) lines.push(`  ${structureLine(nd)}`);
  }

  let truncated = false;
  if (wantActions) {
    // outline: viewport interactables only; actions/full: whole page.
    const acts = nodes.filter(nd => nd.interactable && (level === 'outline' ? nd.inViewport : true));
    lines.push(`[actions] ${acts.length}`);
    let shown = 0;
    for (const nd of acts) {
      const ref = refFor.get(nd);
      if (!ref) continue;
      const line = `  ${refLine(ref, nd)}`;
      if (estTokens(lines.join('\n') + '\n' + line) > cap) { truncated = true; break; }
      lines.push(line);
      shown++;
    }
    if (truncated) lines.push(`  …+${acts.length - shown} more [browse_see level=full or scope=rN]`);
  }

  if (wantText) {
    const prose = String(pageData?.text || '').trim();
    if (prose) {
      // Reserve room; truncate prose to fit the remaining cap.
      const room = Math.max(0, cap - estTokens(lines.join('\n'))) * CHARS_PER_TOKEN;
      const clipped = prose.length > room ? prose.slice(0, room) + ' …[truncated — browse_see level=text scope=rN for a region]' : prose;
      if (prose.length > room) truncated = true;
      lines.push('[text]', clipped);
    }
  }

  return { text: lines.join('\n'), refTable, truncated, refN };
}

/**
 * Compute a delta verdict between two PageData snapshots after an act (§3.3).
 * Code-computed, ~≤100 tokens, never a re-snapshot. `event` carries anything the
 * driver observed during the act (dialog text, download, aria-live).
 */
export function computeDelta(before, after, { actedRef = null, actionLabel = '', event = {} } = {}) {
  const parts = [];
  const navd = before?.url !== after?.url;
  if (navd) parts.push(`navigated to ${after?.url}`);
  else if (before?.title !== after?.title) parts.push(`title → ${after?.title}`);
  else parts.push('no navigation');

  const beforeCount = (before?.nodes ?? []).length;
  const afterCount = (after?.nodes ?? []).length;
  const d = afterCount - beforeCount;
  if (d !== 0) parts.push(`${d > 0 ? '+' : ''}${d} elements`);

  if (event.dialog) parts.push(`dialog (${event.dialog.type}): ${JSON.stringify(event.dialog.message)} — ${event.dialog.handled}`);
  if (event.download) parts.push(`download started: ${event.download}`);
  if (event.ariaLive) parts.push(`announced: ${JSON.stringify(event.ariaLive)}`);
  if (event.validation) parts.push(`form error: ${JSON.stringify(event.validation)}`);
  if (event.newTab) parts.push(`opened tab ${event.newTab}`);

  const head = actedRef ? `ok — ${actionLabel || 'acted'} ${actedRef}` : `ok — ${actionLabel || 'acted'}`;
  return `${head}\n  ${parts.join(' · ')}`;
}
