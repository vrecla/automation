// Structural checks on the generated workflow JSON, so a broken import is caught before you open n8n.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const load = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workflows', f), 'utf8'));
const main = load('call-to-quote.json');
const err = load('error-alert.json');

function reachable(wf, startName) {
  const seen = new Set([startName]);
  const queue = [startName];
  while (queue.length) {
    const n = queue.shift();
    for (const outs of (wf.connections[n] || { main: [] }).main) {
      for (const t of outs) if (!seen.has(t.node)) { seen.add(t.node); queue.push(t.node); }
    }
  }
  return seen;
}

for (const [label, wf, start] of [['main', main, 'Call Transcript Webhook'], ['error', err, 'Error Trigger']]) {
  test(`${label}: node names are unique and every connection points at a real node`, () => {
    const names = wf.nodes.map((n) => n.name);
    assert.strictEqual(new Set(names).size, names.length);
    for (const [from, c] of Object.entries(wf.connections)) {
      assert.ok(names.includes(from), `unknown source ${from}`);
      for (const outs of c.main) for (const t of outs) assert.ok(names.includes(t.node), `unknown target ${t.node}`);
    }
  });

  test(`${label}: every node is reachable from the trigger`, () => {
    const seen = reachable(wf, start);
    for (const n of wf.nodes) assert.ok(seen.has(n.name), `${n.name} is orphaned`);
  });
}

test('every $(\'Node Name\') reference in code and expressions points at a real node', () => {
  const names = new Set(main.nodes.map((n) => n.name));
  const text = JSON.stringify(main);
  const refs = [...text.matchAll(/\$\(\\?'([^']+?)\\?'\)/g)].map((m) => m[1]);
  assert.ok(refs.length > 5);
  for (const r of refs) assert.ok(names.has(r), `reference to missing node "${r}"`);
});

test('Code nodes embed exactly the current source files (run `npm run build` if this fails)', () => {
  const codeNodes = main.nodes.filter((n) => n.type === 'n8n-nodes-base.code');
  assert.strictEqual(codeNodes.length, 7);
  for (const n of codeNodes) {
    const found = fs.readdirSync(path.join(__dirname, '..', 'code')).some(
      (f) => fs.readFileSync(path.join(__dirname, '..', 'code', f), 'utf8') === n.parameters.jsCode);
    assert.ok(found, `${n.name} is out of sync with /code`);
  }
});

test('safety: retries only on idempotent calls, never on record-creating POSTs', () => {
  const retrying = main.nodes.filter((n) => n.retryOnFail).map((n) => n.name).sort();
  assert.deepStrictEqual(retrying, ['Claude Extract', 'Search Existing Deal', 'Search Org']);
});

// A "gate" is a node every path must pass through. Remove it from the graph and the protected nodes
// must become unreachable from the trigger.
function reachableWithout(wf, startName, removed) {
  const seen = new Set([startName]);
  const queue = [startName];
  while (queue.length) {
    const n = queue.shift();
    for (const outs of (wf.connections[n] || { main: [] }).main) {
      for (const t of outs) if (t.node !== removed && !seen.has(t.node)) { seen.add(t.node); queue.push(t.node); }
    }
  }
  return seen;
}

test('safety gates: protected steps are unreachable without passing the gate', () => {
  const start = 'Call Transcript Webhook';
  const gates = [
    ['Is Duplicate?', ['Claude Extract', 'Create Deal']],           // dedupe before LLM spend and CRM writes
    ['Extraction Valid?', ['Calculate Quote', 'Create Org', 'Create Person', 'Create Deal', 'Add Draft Note']], // validation before CRM
    ['Wait - Approval', ['Create Follow-up Activity']],              // nothing "approved" without the wait
    ['Approved?', ['Create Follow-up Activity']],
  ];
  for (const [gate, protectedNodes] of gates) {
    const seen = reachableWithout(main, start, gate);
    for (const p of protectedNodes) assert.ok(!seen.has(p), `${p} is reachable without passing "${gate}"`);
  }
});

test('safety: invalid extractions end at a Slack review message and go no further', () => {
  const falseBranch = main.connections['Extraction Valid?'].main[1];
  assert.deepStrictEqual(falseBranch.map((t) => t.node), ['Slack - Needs Review']);
  assert.strictEqual(main.connections['Slack - Needs Review'], undefined);
});

test('safety: duplicates end at a no-op and go no further', () => {
  assert.deepStrictEqual(main.connections['Is Duplicate?'].main[0].map((t) => t.node), ['Stop - Duplicate']);
  assert.strictEqual(main.connections['Stop - Duplicate'], undefined);
});

test('approval wait is a form with a Decision dropdown and has a timeout', () => {
  const wait = main.nodes.find((n) => n.name === 'Wait - Approval');
  assert.strictEqual(wait.parameters.resume, 'form');
  assert.strictEqual(wait.parameters.limitWaitTime, true);
  const field = wait.parameters.formFields.values[0];
  assert.strictEqual(field.fieldLabel, 'Decision'); // decide-approval.js reads this exact key
  assert.deepStrictEqual(field.fieldOptions.values.map((o) => o.option), ['Approve', 'Reject']);
});

// Regression: n8n signs resume URLs (?signature=...). Appending our own query params to them
// produced {"error":"Invalid token"} in production. The Slack message must use the URL untouched.
test('regression: Slack approval message uses the signed form URL untouched', () => {
  const node = main.nodes.find((n) => n.name === 'Slack - Approval Request');
  const expr = node.parameters.jsonBody;
  assert.ok(expr.includes('$execution.resumeFormUrl'));
  assert.ok(!/resumeUrl/.test(expr), 'must not use resumeUrl');
  assert.ok(!/decision=/i.test(expr), 'must not append decision params');

  // Evaluate the real expression with fake n8n context and check the link is byte-for-byte the signed URL.
  const signed = 'https://n8n-vrecla.onrender.com/form-waiting/123?signature=abc123';
  const fn = new Function('$', '$execution', `return ${expr.replace(/^=\{\{/, '').replace(/\}\}$/, '')}`);
  const $ = (name) => ({ first: () => ({ json: name === 'Create Deal' ? { data: { id: 77 } } : { quote_text: 'QUOTE TEXT' } }) });
  const body = JSON.parse(fn($, { resumeFormUrl: signed }));
  assert.ok(body.text.includes(`<${signed}|`), 'signed URL must appear unmodified');
  assert.ok(body.text.includes('deal #77'));
  assert.ok(body.text.includes('QUOTE TEXT'));
});

test('no node in the workflow appends query strings to resume URLs', () => {
  const text = JSON.stringify(main);
  assert.ok(!/resumeUrl\s*\+\s*['"`]\?/.test(text));
});
