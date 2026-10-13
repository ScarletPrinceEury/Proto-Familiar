/**
 * browse-gate.js — is my browser on, and is it how I read pages?
 *
 * Import-free on purpose: the tool composer (cerebellum) asks these questions
 * every turn and keeps the browser engine (browser.js → the driver) out of its
 * static import graph, so the answers live here and browser.js re-exports them.
 */

/** Browsing is on: the ward's toggle (default OFF) and not the env off-switch. */
export function browseEnabled(settings) {
  if (process.env.PROTO_FAMILIAR_BROWSE_DISABLED === '1') return false;
  return settings?.browseEnabled === true;
}

/**
 * My browser is how I read pages (0.14.65, ward decision): browsing is on and
 * my human hasn't pinned plain reading (`webReadBackend: 'static'`). Then I'm
 * offered browse_open and not read_webpage — the plain reader only serves as
 * browse_open's fallback when the browser can't open a page. Deliberately does
 * NOT require the engine to be installed yet: until it is, browse_open's own
 * fallback reads the page plainly and says why.
 */
export function browserReadsPages(settings) {
  return browseEnabled(settings) && (settings?.webReadBackend ?? 'auto') !== 'static';
}

/** The tool I open a page with this turn — for text that points me at it. */
export function pageReaderTool(settings) {
  return browserReadsPages(settings) ? 'browse_open' : 'read_webpage';
}
