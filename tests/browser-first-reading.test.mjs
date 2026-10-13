// Browser-first reading (0.14.65, ward decision): when my browser is on, it is
// how I read pages. The plain reader (read_webpage) is no longer offered beside
// it — it was winning by default because my own tool descriptions sent me there
// first — and serves only as the fallback when the browser can't open a page.
// When browsing is off (or my human pinned plain reading), read_webpage is the
// reader, and the browse_* tools aren't offered at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { composeActiveTools, BUILTIN_TOOLS } = await import('../cerebellum.js');
const { browseOpen, _setDriverForTest } = await import('../src/browser/browser.js');
const { browserReadsPages, pageReaderTool } = await import('../src/browser/browse-gate.js');
const { readPageText } = await import('../src/browser/page-read.js');
const { searchWeb } = await import('../src/search/websearch.js');

const names = (tools) => new Set(tools.map(t => t.function?.name));
const ON  = { webSearchEnabled: true, browseEnabled: true };
const OFF = { webSearchEnabled: true, browseEnabled: false };
const PINNED_STATIC = { webSearchEnabled: true, browseEnabled: true, webReadBackend: 'static' };

// ── Which reader is offered ────────────────────────────────────────────────
test('browser on: browse_open is offered and read_webpage is not', () => {
  const n = names(composeActiveTools([], ON));
  assert.ok(n.has('browse_open'));
  assert.ok(!n.has('read_webpage'), 'the plain reader is a fallback now, not a choice');
  assert.ok(n.has('web_search'), 'search itself is unchanged');
});

test('browser off: read_webpage is the reader and no browse_* tool is offered', () => {
  const n = names(composeActiveTools([], OFF));
  assert.ok(n.has('read_webpage'));
  for (const name of [...n]) assert.ok(!name.startsWith('browse_'), `${name} offered while browsing is off`);
});

test('the env off-switch counts as browsing off', () => {
  process.env.PROTO_FAMILIAR_BROWSE_DISABLED = '1';
  try {
    const n = names(composeActiveTools([], ON));
    assert.ok(n.has('read_webpage'));
    assert.ok(!n.has('browse_open'));
  } finally { delete process.env.PROTO_FAMILIAR_BROWSE_DISABLED; }
});

test('plain reading pinned by my human: both are offered (browser for using pages)', () => {
  const n = names(composeActiveTools([], PINNED_STATIC));
  assert.ok(n.has('read_webpage'));
  assert.ok(n.has('browse_open'));
});

test('a web turn surfaces whichever tool reads pages', () => {
  const web = new Set(['web']);
  assert.ok(names(composeActiveTools([], ON, { modules: web })).has('browse_open'), 'search → open, no request_tools round');
  const browser = new Set(['browser']);
  assert.ok(names(composeActiveTools([], OFF, { modules: browser })).has('read_webpage'), 'a pasted link still gets a reader');
});

test('no tool description points me at a reader I am not offered', () => {
  for (const settings of [ON, OFF]) {
    const offered = names(composeActiveTools([], settings));
    for (const t of composeActiveTools([], settings)) {
      for (const tool of ['read_webpage', 'browse_open']) {
        if (!offered.has(tool)) {
          assert.ok(!String(t.function?.description).includes(tool),
            `${t.function?.name} mentions ${tool}, which isn't offered (browseEnabled=${settings.browseEnabled})`);
        }
      }
    }
  }
});

test('browserReadsPages / pageReaderTool agree with what is offered', () => {
  assert.equal(browserReadsPages(ON), true);
  assert.equal(browserReadsPages(OFF), false);
  assert.equal(browserReadsPages(PINNED_STATIC), false);
  assert.equal(pageReaderTool(ON), 'browse_open');
  assert.equal(pageReaderTool(OFF), 'read_webpage');
});

// ── Search results name the reader I actually have ────────────────────────
const DDG_HTML = `<div class="result results_links results_links_deep web-result">
  <div class="links_main"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">Result A</a>
  <a class="result__snippet">Snippet A</a></div></div>`;
const searchDeps = {
  lookupFn: async () => [{ address: '93.184.216.34' }],
  fetchFn:  async (href) => ({ ok: true, url: href, status: 200, headers: { get: () => null }, text: async () => DDG_HTML }),
};

test('search results point at browse_open when the browser reads pages', async () => {
  const out = await searchWeb('cats', {}, searchDeps, { openWith: 'browse_open' });
  assert.match(out, /browse_open/);
  assert.doesNotMatch(out, /read_webpage/);
});

// ── browse_open: reading in one call, and the fallback ────────────────────
const ward = { settings: { browseEnabled: true }, sessionId: 's-test' };
const page = (over = {}) => ({ pageData: { url: 'https://news.example/story', title: 'Story', generation: 1, nodes: [], text: 'The whole article body, as prose.', ...over } });

test('browse_open level:text hands me the prose straight away', async () => {
  _setDriverForTest({ navigate: async () => page() });
  try {
    const out = await browseOpen({ url: 'https://news.example/story', level: 'text' }, ward);
    assert.match(out, /The whole article body, as prose\./);
  } finally { _setDriverForTest(null); }
});

const HTML_PAGE = '<html><head><title>Plain</title></head><body><article><h1>Plain copy</h1><p>This paragraph came through the plain reader because the browser could not start.</p></article></body></html>';
const readDeps = {
  lookupFn: async () => [{ address: '93.184.216.34' }],
  fetchFn:  async (href) => ({
    ok: true, url: href, status: 200,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
    text: async () => HTML_PAGE,
  }),
};

test('browser can\'t start → I still read the page, and I\'m told it\'s a plain copy (pipeline)', async () => {
  _setDriverForTest({ navigate: async () => { throw new Error('launch failed: no Chromium'); } });
  try {
    const out = await browseOpen({ url: 'https://news.example/story' }, {
      ...ward,
      fallbackRead: (u) => readPageText(u, { settings: {}, liveRead: false, deps: readDeps }),
    });
    assert.match(out, /came through the plain reader/, 'the real reader + extractor served the page');
    assert.match(out, /plain copy/i);
    assert.match(out, /no live page/i, 'I know there is nothing open to click on');
  } finally { _setDriverForTest(null); }
});

test('a site that turns my browser away (HTTP 403) falls back too', async () => {
  let fellBack = 0;
  _setDriverForTest({ navigate: async () => page({ httpStatus: 403, text: 'Access denied' }) });
  try {
    const out = await browseOpen({ url: 'https://news.example/story' }, { ...ward, fallbackRead: async () => { fellBack++; return 'readable text'; } });
    assert.equal(fellBack, 1);
    assert.match(out, /403/);
    assert.match(out, /readable text/);
  } finally { _setDriverForTest(null); }
});

test('a missing page (404) is shown as is — the plain reader would only 404 too', async () => {
  let fellBack = 0;
  _setDriverForTest({ navigate: async () => page({ httpStatus: 404, text: 'Not found' }) });
  try {
    await browseOpen({ url: 'https://news.example/gone' }, { ...ward, fallbackRead: async () => { fellBack++; return 'x'; } });
    assert.equal(fellBack, 0);
  } finally { _setDriverForTest(null); }
});

test('a site my human blocked is never read through the fallback', async () => {
  let fellBack = 0;
  _setDriverForTest({ navigate: async () => { throw new Error('should not navigate'); } });
  try {
    const out = await browseOpen({ url: 'https://blocked.example/x' }, {
      settings: { browseEnabled: true, browseSiteMode: 'blocklist', browseSiteList: 'blocked.example' },
      fallbackRead: async () => { fellBack++; return 'x'; },
    });
    assert.match(out, /blocked that site/i);
    assert.equal(fellBack, 0);
  } finally { _setDriverForTest(null); }
});

test('reading a site that blocks automated browsers goes straight to its own reader', async () => {
  let navigated = false;
  let readVia = null;
  _setDriverForTest({ navigate: async () => { navigated = true; return page(); } });
  try {
    const out = await browseOpen({ url: 'https://www.reddit.com/r/x/comments/abc/t/', level: 'text' }, {
      ...ward, fallbackRead: async (u) => { readVia = u; return 'thread text'; },
    });
    assert.equal(navigated, false);
    assert.equal(readVia, 'https://www.reddit.com/r/x/comments/abc/t/');
    assert.match(out, /thread text/);
  } finally { _setDriverForTest(null); }
});

test('the browse_open definition offers level for one-call reading', () => {
  const def = BUILTIN_TOOLS.find(t => t.function?.name === 'browse_open');
  assert.deepEqual(def.function.parameters.properties.level.enum, ['outline', 'actions', 'text', 'full']);
});
