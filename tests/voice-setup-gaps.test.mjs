import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

/**
 * The path from "fresh install" to "my Familiar speaks" must never require a
 * terminal.
 *
 * This project is built for people with executive dysfunction. "Run this
 * command" is where someone stops — my human proved it by having to do every
 * step by hand across a night. Before this, all nine entry points mentioned
 * voice ZERO times, and the download and the sidecar existed only as CLI
 * commands nobody was told about.
 *
 * These assert the WIRING, not the wording. They fail when a step falls out of
 * a launcher or an endpoint loses its caller — which is exactly how
 * `installVoice()` sat for days with tests and no caller at all.
 */

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

test('npm install alone brings the speech engine', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.optionalDependencies?.['sherpa-onnx-node'],
    'the binding must be a declared dependency, or a fresh install silently has no voice');
});

test('both installers actually run npm install', () => {
  assert.match(read('install.sh'), /npm install/);
  assert.match(read('install.bat'), /npm install/);
});

test('both installers report whether this machine can speak', () => {
  // sherpa-onnx-node is OPTIONAL, so npm skips it in silence where there is no
  // prebuilt. Without this the install "succeeds" and voice just never works.
  for (const f of ['install.sh', 'install.bat']) {
    assert.match(read(f), /check-voice-ready/, `${f} never checks`);
  }
});

test('every updater ends up in an installer, so updates inherit both', () => {
  assert.match(read('update.sh'), /install\.sh/);
  assert.match(read('update.bat'), /install\.bat/i);
  assert.match(read('update.command'), /update\.sh/);
});

test('the bundled voice ships in the repository', () => {
  // Fetched-on-demand would mean a Familiar that cannot speak offline, and
  // identity should not depend on a working connection.
  assert.ok(existsSync('voices/bundled/p255_023_enhanced.wav'));
});

test('everything a person needs is reachable over HTTP', () => {
  const srv = read('server.js');
  for (const ep of [
    '/api/voice/models',          // is the voice here?
    '/api/voice/install-models',  // get it
    '/api/voice/install-sidecar', // get the better engine
    '/api/voice/choose',          // keep a voice
    '/api/voice/status',          // which engine is really speaking
  ]) {
    assert.ok(srv.includes(ep), `${ep} is missing — that step needs a terminal again`);
  }
});

test('and each of those endpoints has a caller in the UI', () => {
  // An endpoint with no caller is the shape `installVoice()` had for days:
  // tested, working, and unreachable.
  const app = read('public/app.js');
  for (const [fn, why] of [
    ['ensureSpeechModel', 'the speak button must offer the download'],
    ['installVoiceSidecar', 'settings must install the sidecar'],
    ['onVoiceBackendChange', 'settings must switch engine'],
    ['chooseVoice', 'the picker must keep a voice'],
  ]) {
    assert.ok(app.includes(fn), why);
  }
});

test('the engine dropdown exists in the markup, not just in script', () => {
  const html = read('public/index.html');
  assert.match(html, /voice-backend-select/);
  assert.match(html, /voice-sidecar-install/);
});

test('docs tell someone voice exists, and what to do when it does not work', () => {
  assert.match(read('README.md'), /talk out loud/i, 'nobody learns the feature exists otherwise');
  assert.match(read('docs/troubleshooting.md'), /Reading aloud \(voice\)/);
  // The single most expensive lesson of the milestone: a whole debugging round
  // went into the wrong backend because nobody checked the boot line.
  assert.match(read('docs/troubleshooting.md'), /speaking through/);
});
