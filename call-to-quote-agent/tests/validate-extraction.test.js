const test = require('node:test');
const assert = require('node:assert');
const { validateExtraction } = require('../code/validate-extraction.js');
const { samples, wrap, clean, messy, perth } = require('./fixtures.js');

const ctxFor = (s) => ({ transcript: s.transcript, callerPhone: s.caller_phone, minConfidence: 0.7 });
const has = (r, re) => r.errors.some((e) => re.test(e));

test('clean call passes', () => {
  const r = validateExtraction(wrap(clean), ctxFor(samples.clean));
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.data.state, 'QLD');
});

test('messy call is routed to review (low confidence and unclear details)', () => {
  const r = validateExtraction(wrap(messy), ctxFor(samples.messy));
  assert.strictEqual(r.valid, false);
  assert.ok(has(r, /Low confidence/));
  assert.ok(has(r, /unclear details/i));
  // phone comes from call metadata when the caller didn't state one
  assert.strictEqual(r.data.caller_phone, '0433111222');
});

test('out-of-area call fails on service area', () => {
  const r = validateExtraction(wrap(perth), ctxFor(samples.perth));
  assert.strictEqual(r.valid, false);
  assert.ok(has(r, /Outside service area/));
});

test('catches a hallucinated email that is not in the transcript', () => {
  const bad = { ...clean, caller_email: 'sarah@harbourview-bc.com.au' };
  const r = validateExtraction(wrap(bad), ctxFor(samples.clean));
  assert.ok(has(r, /email .* not found in transcript/));
});

test('catches a hallucinated phone number', () => {
  const bad = { ...clean, caller_phone: '0499 000 111' };
  const r = validateExtraction(wrap(bad), ctxFor(samples.clean));
  assert.ok(has(r, /phone .* not found/));
});

test('catches a hallucinated suburb and postcode', () => {
  const r = validateExtraction(wrap({ ...clean, suburb: 'Paddington', postcode: '4064' }), ctxFor(samples.clean));
  assert.ok(has(r, /suburb .* not found/));
  assert.ok(has(r, /postcode .* not found/));
});

test('catches postcode that does not match the state', () => {
  const r = validateExtraction(wrap({ ...clean, state: 'VIC' }), ctxFor(samples.clean));
  assert.ok(has(r, /does not match state/));
});

test('catches bad hazard data', () => {
  const bad = { ...clean, hazards: [
    { location: 'a', type: 'pothole', severity: 'medium', quantity: 1 },
    { location: 'b', type: 'crack', severity: 'huge', quantity: 1 },
    { location: 'c', type: 'crack', severity: 'low', quantity: 2.5 },
    { location: 'd', type: 'crack', severity: 'low', quantity: 9999 },
  ] };
  const r = validateExtraction(wrap(bad), ctxFor(samples.clean));
  assert.ok(has(r, /unknown type/));
  assert.ok(has(r, /unknown severity/));
  assert.strictEqual(r.errors.filter((e) => /quantity must be/.test(e)).length, 2);
});

test('rejects empty hazards and missing contact details', () => {
  const r = validateExtraction(wrap({ ...clean, hazards: [], caller_email: null, caller_phone: null }), { ...ctxFor(samples.clean), callerPhone: null });
  assert.ok(has(r, /No hazards/));
  assert.ok(has(r, /No phone or email/));
});

test('fails safe when the model returns no tool call or is truncated', () => {
  assert.strictEqual(validateExtraction({ content: [{ type: 'text', text: 'Sure! Here is the quote' }] }, ctxFor(samples.clean)).valid, false);
  assert.strictEqual(validateExtraction(null, {}).valid, false);
  assert.strictEqual(validateExtraction(wrap(clean, 'max_tokens'), ctxFor(samples.clean)).valid, false);
});

test('high self-reported confidence does NOT override unclear fields (regression: live run let sample 02 through)', () => {
  const r = validateExtraction(wrap({ ...messy, confidence: 0.85 }), ctxFor(samples.messy));
  assert.strictEqual(r.valid, false);
  assert.ok(has(r, /unclear details.*exact slab count/i));
  assert.ok(!has(r, /Low confidence/));
});

test('a complete, clear call with no unclear fields still passes', () => {
  assert.strictEqual(validateExtraction(wrap({ ...clean, unclear_fields: [] }), ctxFor(samples.clean)).valid, true);
});
