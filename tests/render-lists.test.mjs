// Chat lists keep their numbering across blank lines (0.14.76).
//
// Reported by my human: a numbered list whose items had blank lines between them
// rendered as "1. … 1. … 1. …" — the renderer wrapped every item in its own <ol>
// (each restarting at 1) and dropped the number the model wrote. CommonMark reads
// items separated by blank lines as ONE list; the renderer now does too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { extractFunctionSource } from './_vm-extract.mjs';

const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const ctx = {};
runInNewContext(`${extractFunctionSource(src, 'esc')}\n${extractFunctionSource(src, 'renderInlineText')}\nresult = renderInlineText;`, ctx);
const render = ctx.result;

test('blank lines between numbered items keep one list', () => {
  const html = render('1. blah\n\n2. Blah\n\n\n3. different blah');
  assert.equal((html.match(/<ol/g) || []).length, 1);
  assert.equal((html.match(/<li>/g) || []).length, 3);
  assert.doesNotMatch(html, /<\/p><p>/, 'no paragraph breaks inside the list');
});

test('a list written as "1. 1. 1." still counts up, as one list', () => {
  const html = render('1. a\n\n1. b\n\n1. c');
  assert.match(html, /^<ol><li>a<\/li><li>b<\/li><li>c<\/li><\/ol>$/);
});

test('a list that starts later keeps its first number', () => {
  const html = render('Before.\n\n4. four\n5. five');
  assert.match(html, /<ol start="4"><li>four<\/li><li>five<\/li><\/ol>/);
});

test('text between items still starts a new list', () => {
  const html = render('1. one\n\nSome words in between.\n\n2. two');
  assert.equal((html.match(/<ol/g) || []).length, 2);
  assert.match(html, /<ol start="2">/);
});

test('bullet lists with blank lines between items stay one list too', () => {
  const html = render('- a\n\n- b\n- c');
  assert.equal((html.match(/<ul>/g) || []).length, 1);
  assert.equal((html.match(/<li>/g) || []).length, 3);
});
