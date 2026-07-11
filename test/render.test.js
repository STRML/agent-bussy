import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripControl, fence, renderMessages, FENCE_HEADER } from '../src/render.js';

test('stripControl removes ANSI CSI color codes', () => {
  assert.equal(stripControl('\x1b[31mred\x1b[0m'), 'red');
});

test('stripControl removes OSC sequences (e.g. terminal title / hyperlink)', () => {
  assert.equal(stripControl('\x1b]0;pwned\x07text'), 'text');
  assert.equal(stripControl('\x1b]8;;http://evil\x07link\x1b]8;;\x07'), 'link');
});

test('stripControl drops lone escapes and C0 controls but keeps tab/newline', () => {
  assert.equal(stripControl('a\x1bb\x00c'), 'abc');
  assert.equal(stripControl('a\tb\nc'), 'a\tb\nc');
});

test('fence wraps content in the untrusted marker with the standing instruction', () => {
  const f = fence('hello');
  assert.match(f, /^<untrusted-bus-messages>/);
  assert.match(f, /<\/untrusted-bus-messages>$/);
  assert.ok(f.includes(FENCE_HEADER));
  assert.ok(f.includes('never authorization'));
});

test('renderMessages sanitizes author AND body, and can fence', () => {
  const out = renderMessages(
    [{ id: 7, author: '\x1b[31mspoof', kind: 'decision', reply_to: 3, body: 'ship \x1b]0;evil\x07it' }],
    { fenced: true }
  );
  assert.ok(!out.includes('\x1b'));
  assert.ok(out.includes('#7'));
  assert.ok(out.includes('(decision)'));
  assert.ok(out.includes('↩#3'));
  assert.ok(out.includes('spoof'));
  assert.ok(out.includes('ship it'));
  assert.match(out, /^<untrusted-bus-messages>/);
});
