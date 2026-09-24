// Structural + behavioural tests for workflows/daily-digest.json (no n8n needed).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { NOW, DEALS } = require('./helpers');

const wf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workflows', 'daily-digest.json'), 'utf8'));
const node = (name) => wf.nodes.find((n) => n.name === name);
const src = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

test('names are unique and every connection points at a real node', () => {
  const names = wf.nodes.map((n) => n.name);
  assert.strictEqual(new Set(names).size, names.length);
  for (const [from, types] of Object.entries(wf.connections)) {
    assert.ok(names.includes(from), `unknown source ${from}`);
    for (const outs of Object.values(types)) for (const o of outs) for (const t of o) assert.ok(names.includes(t.node), `unknown target ${t.node}`);
  }
});

test('every node is connected to something (no orphans)', () => {
  const touched = new Set();
  for (const [from, types] of Object.entries(wf.connections)) {
    touched.add(from);
    for (const outs of Object.values(types)) for (const o of outs) for (const t of o) touched.add(t.node);
  }
  for (const n of wf.nodes) assert.ok(touched.has(n.name), `${n.name} is orphaned`);
});

test('agent has exactly one model and one tool node attached via AI connections', () => {
  assert.deepStrictEqual(wf.connections['Claude'].ai_languageModel[0].map((t) => t.node), ['Digest Agent']);
  assert.deepStrictEqual(wf.connections['Ops MCP Tools'].ai_tool[0].map((t) => t.node), ['Digest Agent']);
});

test('SAFETY: the agent is given read tools only; add_note is never exposed to it', () => {
  const tools = node('Ops MCP Tools').parameters;
  assert.strictEqual(tools.include, 'selected');
  assert.deepStrictEqual([...tools.includeTools].sort(), ['get_deal_summary', 'get_open_deals', 'get_stale_deals']);
  assert.ok(!JSON.stringify(wf).includes('add_note') || !JSON.stringify(tools).includes('add_note'));
  assert.ok(!node('Digest Agent').parameters.options.systemMessage.includes('add_note'));
});

test('SAFETY: nothing reaches Slack without passing Reconcile and the verified check', () => {
  const seen = new Set(['Weekdays 8am', 'Manual Test']);
  const q = ['Weekdays 8am', 'Manual Test'];
  while (q.length) {
    const n = q.shift();
    for (const outs of Object.values(wf.connections[n] || {})) for (const o of outs) for (const t of o) {
      if (t.node === 'Reconcile' || seen.has(t.node)) continue; // remove the gate
      seen.add(t.node); q.push(t.node);
    }
  }
  assert.ok(!seen.has('Slack - Digest'), 'digest Slack post reachable without Reconcile');
  assert.ok(!seen.has('Slack - Digest Withheld'));
  // and the "posted" branch is the TRUE output of the verified check
  assert.strictEqual(wf.connections['Digest Verified?'].main[0][0].node, 'Slack - Digest');
  assert.strictEqual(wf.connections['Digest Verified?'].main[1][0].node, 'Slack - Digest Withheld');
});

test('retries only on idempotent GETs, never on Slack posts', () => {
  assert.deepStrictEqual(wf.nodes.filter((n) => n.retryOnFail).map((n) => n.name).sort(), ['Fetch Open Deals', 'Wake MCP Server']);
});

test('Code nodes embed the current source files (run `npm run build:workflow` if this fails)', () => {
  assert.strictEqual(node('Compute Facts').parameters.jsCode, src('src', 'domain.js') + '\n' + src('n8n', 'compute-facts.glue.js'));
  assert.strictEqual(node('Reconcile').parameters.jsCode, src('src', 'reconcile.js') + '\n' + src('n8n', 'reconcile.glue.js'));
});

test('schedule is weekdays 8am with an explicit Australian timezone', () => {
  assert.strictEqual(node('Weekdays 8am').parameters.rule.interval[0].expression, '0 8 * * 1-5');
  assert.strictEqual(wf.settings.timezone, 'Australia/Melbourne');
});

// ---- run the embedded Code nodes exactly as n8n would, with a fake runtime ----
function run(name, inputJson, outputs) {
  const $ = (n) => { if (!(n in outputs)) throw new Error(`Node "${n}" has not run`); return { first: () => ({ json: outputs[n] }) }; };
  const fn = new Function('$input', '$', node(name).parameters.jsCode);
  const res = fn({ first: () => ({ json: inputJson }) }, $);
  outputs[name] = res[0].json;
  return res[0].json;
}
const realNow = Date.now;
const withFixedClock = (fn) => { Date.now = () => NOW; try { return fn(); } finally { Date.now = realNow; } };
const pdResponse = (data, next = null) => ({ success: true, data, additional_data: { next_cursor: next } });
const openDeals = DEALS.filter((d) => d.status === 'open');

test('embedded Compute Facts computes the same facts as the MCP server logic', () => withFixedClock(() => {
  const out = { Config: { staleDays: 7 } };
  const facts = run('Compute Facts', pdResponse(openDeals), out);
  assert.strictEqual(facts.open_count, 5);
  assert.deepStrictEqual(facts.stale_ids, [2, 4]);
}));

test('embedded Compute Facts fails loudly on bad input instead of producing wrong numbers', () => withFixedClock(() => {
  assert.throws(() => run('Compute Facts', { success: false, error: 'x' }, { Config: { staleDays: 7 } }), /Unexpected Pipedrive response/);
  assert.throws(() => run('Compute Facts', pdResponse(openDeals, 'more'), { Config: { staleDays: 7 } }), /More than 500 open deals/);
  assert.throws(() => run('Compute Facts', pdResponse(openDeals), { Config: { staleDays: 0 } }), /staleDays/);
  assert.throws(() => run('Compute Facts', pdResponse(openDeals), { Config: { staleDays: 'abc' } }), /staleDays/);
}));

test('embedded Reconcile: correct agent output is verified and posted; wrong output is withheld', () => withFixedClock(() => {
  const out = { Config: { staleDays: 7 } };
  run('Compute Facts', pdResponse(openDeals), out);
  const good = '```json\n' + JSON.stringify({ headline: 'Two deals need a nudge.', open_deals_count: 5, stale_deals_count: 2, stale_deal_ids: [2, 4], follow_ups: [{ deal_id: 2, action: 'Call the client' }] }) + '\n```';
  const ok = run('Reconcile', { output: good }, out);
  assert.strictEqual(ok.ok, true);
  assert.match(ok.text, /Open deals: \*5\*/);

  const bad = JSON.stringify({ headline: 'All fine!', open_deals_count: 5, stale_deals_count: 0, stale_deal_ids: [], follow_ups: [] });
  const withheld = run('Reconcile', { output: bad }, out);
  assert.strictEqual(withheld.ok, false);
  assert.strictEqual(withheld.text, null, 'no digest text is produced for a failed reconciliation');
  assert.match(withheld.problems.join(' '), /stale_deals_count/);
  assert.deepStrictEqual(withheld.facts_summary.stale_ids, [2, 4]);

  const prose = run('Reconcile', { output: 'Sorry, I could not reach the tools.' }, out);
  assert.strictEqual(prose.ok, false);
  assert.match(prose.problems[0], /Could not parse agent output/);
  const empty = run('Reconcile', { output: undefined }, out);
  assert.strictEqual(empty.ok, false);
}));

test('the withheld-alert expression builds a readable message from the Reconcile output', () => {
  const expr = node('Slack - Digest Withheld').parameters.jsonBody.replace(/^=\{\{/, '').replace(/\}\}$/, '');
  const fn = new Function('$json', `return ${expr}`);
  const body = JSON.parse(fn({ problems: ['a', 'b'], facts_summary: { open: 5, stale: 2, stale_ids: [2, 4] } }));
  assert.match(body.text, /digest withheld/i);
  assert.match(body.text, /- a\n- b/);
  assert.match(body.text, /5 open, 2 stale \(ids 2, 4\)/);
});

test('the MCP server is woken (with a long timeout) before the agent runs', () => {
  assert.strictEqual(wf.connections['Wake MCP Server'].main[0][0].node, 'Digest Agent');
  assert.strictEqual(wf.connections['Compute Facts'].main[0][0].node, 'Wake MCP Server');
  const wake = node('Wake MCP Server').parameters;
  assert.ok(wake.options.timeout >= 60000);
  assert.match(wake.url, /mcpBaseUrl.*\/health/);
});
