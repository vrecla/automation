const test = require('node:test');
const assert = require('node:assert');
const { validateInput } = require('../code/validate-input.js');
const { samples } = require('./fixtures.js');

test('accepts a good payload and normalises it', () => {
  const out = validateInput(samples.clean);
  assert.strictEqual(out.call_id, 'CALL-1001');
  assert.strictEqual(out.caller_phone, '0412345678');
  assert.match(out.recorded_at, /^2026-09-22T23:41:00/);
});

test('rejects missing / bad fields with a clear message', () => {
  assert.throws(() => validateInput({}), /call_id/);
  assert.throws(() => validateInput({ call_id: 'A B', transcript: 'x'.repeat(60), recorded_at: '2026-01-01' }), /call_id/);
  assert.throws(() => validateInput({ call_id: 'CALL-1', transcript: 'short', recorded_at: '2026-01-01' }), /too short/);
  assert.throws(() => validateInput({ call_id: 'CALL-1', transcript: 'x'.repeat(60), recorded_at: 'not-a-date' }), /recorded_at/);
  assert.throws(() => validateInput(undefined), /Invalid webhook payload/);
});
