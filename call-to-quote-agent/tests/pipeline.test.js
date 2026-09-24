// End-to-end simulation of the Code nodes exactly as embedded in workflows/call-to-quote.json.
// A tiny fake n8n runtime supplies $input and $('Node Name'). No network, no n8n needed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { samples, wrap, clean, messy, perth } = require('./fixtures.js');

const wf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workflows', 'call-to-quote.json'), 'utf8'));
const codeOf = (name) => wf.nodes.find((n) => n.name === name).parameters.jsCode;

// Runs a node's code with fake n8n globals. `outputs` holds the results of earlier nodes.
function run(name, inputJson, outputs) {
  const $ = (nodeName) => {
    if (!(nodeName in outputs)) throw new Error(`Node "${nodeName}" has not run`); // mirrors n8n behaviour
    return { first: () => ({ json: outputs[nodeName] }) };
  };
  const $input = { first: () => ({ json: inputJson }) };
  const fn = new Function('$input', '$', codeOf(name)); // same scoping idea as n8n: no `module`, top-level return
  const result = fn($input, $);
  outputs[name] = result[0].json;
  return result[0].json;
}

const CONFIG = { slackWebhookUrl: 'x', claudeModel: 'claude-haiku-4-5-20251001', minConfidence: 0.7 };

function upToValidation(sample, claudeInput, stopReason) {
  const outputs = { Config: CONFIG };
  run('Validate Input', { body: sample }, outputs);
  const req = run('Build Claude Request', {}, outputs);
  assert.strictEqual(req.claudeBody.model, CONFIG.claudeModel);
  const validated = run('Validate Extraction', wrap(claudeInput, stopReason), outputs);
  return { outputs, validated };
}

test('clean call: every node runs and produces the exact records we expect', () => {
  const { outputs, validated } = upToValidation(samples.clean, clean);
  assert.strictEqual(validated.valid, true);
  assert.ok(!('transcript' in validated), 'transcript must not travel downstream');

  const q = run('Calculate Quote', validated, outputs);
  assert.strictEqual(q.quote.total_cents, 92400);
  assert.strictEqual(q.deal_title, 'Footpath repairs - 27 Ferry Lane, Newstead [CALL-1001]');
  assert.strictEqual(q.org_name, 'Harbourview Body Corporate');

  // Org does not exist yet -> create branch
  const r1 = run('Resolve Org', { success: true, data: { items: [] } }, outputs);
  assert.strictEqual(r1.needsCreate, true);
  outputs['Create Org'] = { data: { id: 555 } };
  const c = run('Collect Org ID', {}, outputs);
  assert.strictEqual(c.org_id, 555);
  assert.strictEqual(c.person_payload.org_id, 555);
  assert.strictEqual(c.person_payload.email[0].value, 'sarah.nguyen@harbourview-bc.example');

  assert.strictEqual(run('Decide', { Decision: 'Approve', submittedAt: '2026-09-24T00:00:00Z', formMode: 'production' }, outputs).decision, 'approved');
});

test('existing org: the Create Org node is never read', () => {
  const { outputs, validated } = upToValidation(samples.clean, clean);
  run('Calculate Quote', validated, outputs);
  run('Resolve Org', { data: { items: [{ item: { id: 9, name: 'Harbourview Body Corporate' } }] } }, outputs);
  assert.ok(!('Create Org' in outputs));
  assert.strictEqual(run('Collect Org ID', {}, outputs).org_id, 9);
});

test('messy call is stopped by validation with reasons a human can act on', () => {
  const { validated } = upToValidation(samples.messy, messy);
  assert.strictEqual(validated.valid, false);
  assert.ok(validated.errors.join(' ').includes('Low confidence'));
  assert.ok(validated.errors.join(' ').includes('exact slab count'));
});

test('out-of-area + prompt injection call is stopped before pricing', () => {
  const { validated } = upToValidation(samples.perth, perth);
  assert.strictEqual(validated.valid, false);
  assert.ok(validated.errors.join(' ').includes('Outside service area'));
});

test('malformed webhook payload throws (which triggers the error-alert workflow)', () => {
  assert.throws(() => run('Validate Input', { body: { call_id: 'CALL-9' } }, { Config: CONFIG }), /Invalid webhook payload/);
});

test('model returning prose instead of a tool call is stopped, not trusted', () => {
  const outputs = { Config: CONFIG };
  run('Validate Input', { body: samples.clean }, outputs);
  const v = run('Validate Extraction', { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Your quote is $1' }] }, outputs);
  assert.strictEqual(v.valid, false);
});
