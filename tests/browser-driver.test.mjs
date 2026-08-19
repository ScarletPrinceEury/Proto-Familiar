import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findChromium, status, extractPageData } from '../browser-driver.js';
import { buildRefTable, isProtectedField } from '../browser-lens.js';

test('status() before any launch reports not running, never throws', () => {
  const s = status();
  assert.equal(s.running, false);
  assert.equal(s.tabs, 0);
});

test('findChromium returns a path or null, never throws', () => {
  const p = findChromium();
  assert.ok(p === null || typeof p === 'string');
});

// ── Live extraction (skips when no Chromium is available) ──────────────────
const exe = findChromium();
const live = exe ? test : test.skip;

live('extractPageData walks the real DOM into the lens shape; css resolves + acts', async () => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  try {
    await page.setContent(`
      <main aria-label="shop">
        <h1>Oat Milk</h1>
        <div><button aria-label="Add to basket">Add</button></div>
        <label for="qty">Quantity</label><input id="qty" type="number">
        <input type="password" aria-label="Password">
        <p id="log"></p>
        <button id="danger" onclick="if(confirm('Delete everything?')) document.getElementById('log').textContent='DELETED'">Delete</button>
      </main>`);

    const data = await extractPageData(page);
    assert.equal(data.title !== undefined, true);
    const names = data.nodes.filter(n => n.interactable).map(n => n.name);
    assert.ok(names.includes('Add to basket'), `names: ${names.join(', ')}`);

    const { byRef, order } = buildRefTable(data);
    // The password field must be flagged protected.
    const pw = [...byRef.values()].find(e => e.node.type === 'password');
    assert.ok(pw && pw.protected, 'password field flagged protected');
    assert.equal(isProtectedField(pw.node), true);

    // Every interactable's css must resolve to exactly one element (the §3.2
    // unique-match guarantee) and be actionable.
    for (const ref of order) {
      const css = byRef.get(ref).node.css;
      assert.equal(await page.locator(css).count(), 1, `ref ${ref} css not unique: ${css}`);
    }

    // Act: click the "Add" button by its css → no crash, element was real.
    const addEntry = [...byRef.values()].find(e => e.node.name === 'Add to basket');
    await page.locator(addEntry.node.css).click();

    // Dialog policy: clicking Delete raises a confirm; dismissing it (default)
    // must leave the page unchanged — the page's own instruction is declined.
    page.once('dialog', d => d.dismiss());
    const danger = [...byRef.values()].find(e => e.node.name === 'Delete');
    await page.locator(danger.node.css).click();
    await page.waitForTimeout(100);
    assert.notEqual(await page.locator('#log').textContent(), 'DELETED');
  } finally {
    await browser.close();
  }
});
