import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJsonObject } from '../scanner/portalScanner.mjs';

// extractJsonObject(str, start): from the '{' at `start`, return the balanced
// object substring, respecting strings and escapes.

test('extractJsonObject returns a simple balanced object', () => {
  const s = 'prefix {"a":1} suffix';
  const start = s.indexOf('{');
  assert.equal(extractJsonObject(s, start), '{"a":1}');
});

test('extractJsonObject handles nested objects', () => {
  const s = 'x = {"a":{"b":{"c":2}},"d":3};';
  const start = s.indexOf('{');
  assert.equal(extractJsonObject(s, start), '{"a":{"b":{"c":2}},"d":3}');
});

test('extractJsonObject ignores braces inside string values', () => {
  const s = '{"note":"a } brace in a string","n":1}';
  assert.equal(extractJsonObject(s, 0), s);
});

test('extractJsonObject respects escaped quotes inside strings', () => {
  const s = '{"q":"she said \\"hi\\" }","n":1}';
  assert.equal(extractJsonObject(s, 0), s);
});

test('extractJsonObject edge case: an unterminated object throws', () => {
  assert.throws(() => extractJsonObject('{"a":1', 0), /Unterminated JSON object/);
});
