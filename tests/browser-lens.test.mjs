import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRefTable, isProtectedField, renderSnapshot, computeDelta, LEVEL_CAPS,
} from '../browser-lens.js';

// A small fixture page: a product card with a fillable qty, an add button, a
// password field (protected), and some structure. No browser involved.
const page = {
  url: 'https://shop.example/oat-milk',
  title: 'Oat Milk 1L',
  generation: 1,
  nodes: [
    { role: 'heading', name: 'Oat Milk 1L', tag: 'h1', interactable: false, inViewport: true },
    { role: 'textbox', name: 'Quantity', tag: 'input', type: 'number', interactable: true, inViewport: true, section: "product card 'Oat Milk'", nth: 0 },
    { role: 'button', name: 'Add to basket', tag: 'button', interactable: true, inViewport: true, section: "product card 'Oat Milk'", nth: 0 },
    { role: 'textbox', name: 'Password', tag: 'input', type: 'password', interactable: true, inViewport: true, section: 'account', nth: 0 },
    { role: 'link', name: 'Help', tag: 'a', interactable: true, inViewport: false, section: 'footer', nth: 0 },
  ],
  text: 'Creamy oat milk, 1 litre. Barista edition.',
};

test('buildRefTable mints r-refs for interactables only, with locators', () => {
  const { order, byRef } = buildRefTable(page);
  assert.deepEqual(order, ['r1', 'r2', 'r3', 'r4']); // 4 interactables, heading excluded
  assert.equal(byRef.get('r1').node.name, 'Quantity');
  assert.deepEqual(byRef.get('r2').locator, { role: 'button', name: 'Add to basket', nth: 0 });
  assert.equal(byRef.get('r3').protected, true); // password field
});

test('isProtectedField catches password, file, and credential-named fields', () => {
  assert.equal(isProtectedField({ tag: 'input', type: 'password' }), true);
  assert.equal(isProtectedField({ tag: 'input', type: 'file' }), true);
  assert.equal(isProtectedField({ tag: 'input', type: 'text', name: 'Card number' }), true);
  assert.equal(isProtectedField({ tag: 'input', type: 'text', name: 'CVV' }), true);
  assert.equal(isProtectedField({ tag: 'input', type: 'text', name: 'Search' }), false);
});

test('outline shows viewport interactables and flags the protected field', () => {
  const { text } = renderSnapshot(page, { level: 'outline' });
  assert.match(text, /r2 button "Add to basket" \(in: product card 'Oat Milk'\)/);
  assert.match(text, /r3 textbox "Password".*protected — I can't fill this/);
  assert.doesNotMatch(text, /r4 link "Help"/); // not in viewport → excluded from outline
});

test('actions level includes whole-page interactables (the footer link)', () => {
  const { text } = renderSnapshot(page, { level: 'actions' });
  assert.match(text, /r4 link "Help"/);
});

test('scope narrows to one section', () => {
  const { text } = renderSnapshot(page, { level: 'actions', scope: 'r2' });
  assert.match(text, /scope: r2/);
  assert.match(text, /Add to basket/);
  assert.doesNotMatch(text, /Help/); // footer link is a different section
});

test('an unknown scope ref returns a re-observe hint, not a crash', () => {
  const { text } = renderSnapshot(page, { level: 'actions', scope: 'r99' });
  assert.match(text, /unknown ref r99 — browse_see to re-observe/);
});

test('a huge page truncates explicitly under the cap', () => {
  const big = {
    url: 'https://x', title: 'Big', generation: 1,
    nodes: Array.from({ length: 500 }, (_, i) => ({
      role: 'button', name: `Button number ${i} with a longish label`, tag: 'button',
      interactable: true, inViewport: true, section: 'grid', nth: i,
    })),
  };
  const { text, truncated } = renderSnapshot(big, { level: 'outline' });
  assert.equal(truncated, true);
  assert.match(text, /…\+\d+ more \[browse_see level=full or scope=rN\]/);
  // token estimate stays within the cap (+ a small tolerance for the hint line)
  assert.ok(Math.ceil(text.length / 4) <= LEVEL_CAPS.outline + 40);
});

test('computeDelta reports navigation, element delta, and a handled dialog', () => {
  const before = page;
  const after = { ...page, url: 'https://shop.example/basket', title: 'Basket', nodes: page.nodes.slice(0, 3) };
  const v = computeDelta(before, after, {
    actedRef: 'r2', actionLabel: 'clicked',
    event: { dialog: { type: 'confirm', message: 'Add to basket?', handled: 'dismissed' } },
  });
  assert.match(v, /ok — clicked r2/);
  assert.match(v, /navigated to https:\/\/shop\.example\/basket/);
  assert.match(v, /-2 elements/);
  assert.match(v, /dialog \(confirm\).*dismissed/);
});

test('computeDelta on a no-op act says no navigation', () => {
  const v = computeDelta(page, page, { actedRef: 'r1', actionLabel: 'filled' });
  assert.match(v, /ok — filled r1/);
  assert.match(v, /no navigation/);
});

// ── Pass 3a: hardened credential/payment field detection ───────────────────
test('isProtectedField catches autocomplete + name/inputmode payment heuristics', () => {
  assert.equal(isProtectedField({ tag: 'input', type: 'text', autocomplete: 'cc-number' }), true);
  assert.equal(isProtectedField({ tag: 'input', type: 'text', autocomplete: 'cc-csc' }), true);
  assert.equal(isProtectedField({ tag: 'input', type: 'text', autocomplete: 'current-password' }), true);
  assert.equal(isProtectedField({ tag: 'input', type: 'text', name: 'IBAN' }), true);
  assert.equal(isProtectedField({ tag: 'input', type: 'text', name: 'Routing number' }), true);
  assert.equal(isProtectedField({ tag: 'input', type: 'tel', name: 'Card CVV' }), true);
  assert.equal(isProtectedField({ tag: 'input', type: 'text', inputmode: 'numeric', name: 'security code' }), true);
  // A normal search/name field with a numeric mode is NOT protected.
  assert.equal(isProtectedField({ tag: 'input', type: 'text', inputmode: 'numeric', name: 'Quantity' }), false);
  assert.equal(isProtectedField({ tag: 'input', type: 'text', autocomplete: 'email', name: 'Email' }), false);
});

// ── Pass 3b: the fill-source gate (vault vs model bytes) ───────────────────
import { evaluateFill, protectedKind } from '../browser-lens.js';

test('protectedKind classifies payment vs credential vs plain', () => {
  assert.equal(protectedKind({ tag: 'input', type: 'text', autocomplete: 'cc-number' }), 'payment');
  assert.equal(protectedKind({ tag: 'input', type: 'password' }), 'credential');
  assert.equal(protectedKind({ tag: 'input', type: 'text', name: 'Search' }), null);
});

test('evaluateFill: a plain field takes model value; a stray secret is refused', () => {
  const plain = { tag: 'input', type: 'text', name: 'Search' };
  assert.deepEqual(evaluateFill(plain, { value: 'kittens' }), { ok: true, value: 'kittens', grantUsed: null });
  assert.equal(evaluateFill(plain, { secret: 'oops' }).ok, false); // no secrets into arbitrary boxes
});

test('evaluateFill: a protected field refuses model bytes and needs the matching grant', () => {
  const pw = { tag: 'input', type: 'password', name: 'Password' };
  assert.equal(evaluateFill(pw, { value: 'typed' }).ok, false);            // model bytes refused
  assert.equal(evaluateFill(pw, { secret: 's', grants: {} }).ok, false);   // vault but no grant
  const okd = evaluateFill(pw, { secret: 's', grants: { credentials: true } });
  assert.deepEqual(okd, { ok: true, value: 's', grantUsed: 'credentials' });
  // a payment field needs the payments grant, not credentials
  const card = { tag: 'input', type: 'text', autocomplete: 'cc-number' };
  assert.equal(evaluateFill(card, { secret: 's', grants: { credentials: true } }).ok, false);
  assert.equal(evaluateFill(card, { secret: 's', grants: { payments: true } }).grantUsed, 'payments');
});
