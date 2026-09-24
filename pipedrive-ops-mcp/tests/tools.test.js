// Tool behaviour through a real MCP client connected in-memory to the real server object.
const test = require('node:test');
const assert = require('node:assert');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { buildMcpServer } = require('../src/mcp');
const { createPipedriveClient } = require('../src/pipedrive');
const { NOW, PD_TOKEN, startMockPipedrive } = require('./helpers');

async function connect({ allowWrites = false } = {}) {
  const mock = await startMockPipedrive();
  const pipedrive = createPipedriveClient({ baseUrl: mock.url, token: PD_TOKEN, sleep: async () => {} });
  const logs = [];
  const server = buildMcpServer({ pipedrive, allowWrites, now: () => NOW, log: (e) => logs.push(e) });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, mock, logs, close: async () => { await client.close(); await mock.close(); } };
}
const parse = (r) => JSON.parse(r.content[0].text);

test('lists exactly the four expected tools, with correct read/write hints', async () => {
  const { client, close } = await connect();
  try {
    const { tools } = await client.listTools();
    assert.deepStrictEqual(tools.map((t) => t.name).sort(), ['add_note', 'get_deal_summary', 'get_open_deals', 'get_stale_deals']);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const n of ['get_open_deals', 'get_stale_deals', 'get_deal_summary']) assert.strictEqual(byName[n].annotations.readOnlyHint, true, n);
    assert.strictEqual(byName.add_note.annotations.readOnlyHint, false);
  } finally { await close(); }
});

test('get_open_deals: totals, top-by-value ordering, limit respected', async () => {
  const { client, close } = await connect();
  try {
    const out = parse(await client.callTool({ name: 'get_open_deals', arguments: { limit: 2 } }));
    assert.strictEqual(out.total_open, 5);
    assert.strictEqual(out.value_by_currency.AUD, 27722.9);
    assert.deepStrictEqual(out.deals.map((d) => d.id), [5, 2]);
    assert.strictEqual(out.showing, 2);
  } finally { await close(); }
});

test('get_stale_deals: default 7 days, custom threshold, and full id list for reconciliation', async () => {
  const { client, close } = await connect();
  try {
    const d7 = parse(await client.callTool({ name: 'get_stale_deals', arguments: {} }));
    assert.strictEqual(d7.stale_count, 2);
    assert.deepStrictEqual(d7.stale_deal_ids, [2, 4]);
    assert.deepStrictEqual(d7.deals.map((d) => d.id), [4, 2]);
    const d3 = parse(await client.callTool({ name: 'get_stale_deals', arguments: { days: 3, limit: 1 } }));
    assert.strictEqual(d3.stale_count, 3);
    assert.strictEqual(d3.showing, 1);
    assert.deepStrictEqual(d3.stale_deal_ids, [2, 3, 4], 'the id list is complete even when details are limited');
  } finally { await close(); }
});

test('input validation rejects out-of-range arguments', async () => {
  const { client, close } = await connect();
  try {
    for (const args of [{ days: 0 }, { days: 9999 }, { limit: 0 }, { limit: 101 }, { days: 'seven' }]) {
      const r = await client.callTool({ name: 'get_stale_deals', arguments: args }).catch((e) => ({ isError: true, thrown: e }));
      assert.strictEqual(r.isError, true, JSON.stringify(args));
    }
  } finally { await close(); }
});

test('get_deal_summary strips markup from notes and labels them untrusted', async () => {
  const { client, close } = await connect();
  try {
    const r = await client.callTool({ name: 'get_deal_summary', arguments: { deal_id: 1 } });
    const out = parse(r);
    assert.strictEqual(out.deal.id, 1);
    assert.strictEqual(out.open_activities[0].subject, 'Call client back');
    assert.ok(out.recent_notes_untrusted.length === 1);
    const note = out.recent_notes_untrusted[0].text;
    assert.ok(!/[<>]/.test(note), 'no markup reaches the model');
    assert.ok(note.startsWith('DRAFT QUOTE Total: $924.00'));
    assert.ok(!r.content[0].text.includes('<script>'));
  } finally { await close(); }
});

test('get_deal_summary for a missing deal returns a clean error, not a crash', async () => {
  const { client, close } = await connect();
  try {
    const r = await client.callTool({ name: 'get_deal_summary', arguments: { deal_id: 424242 } });
    assert.strictEqual(r.isError, true);
    assert.match(r.content[0].text, /HTTP 404/);
    assert.ok(!r.content[0].text.includes(PD_TOKEN));
  } finally { await close(); }
});

test('add_note is refused when writes are disabled (default)', async () => {
  const { client, mock, close } = await connect({ allowWrites: false });
  try {
    const r = await client.callTool({ name: 'add_note', arguments: { deal_id: 1, content: 'hello', confirm: true } });
    assert.strictEqual(r.isError, true);
    assert.match(r.content[0].text, /Writes are disabled/);
    assert.strictEqual(mock.state.notesPosted.length, 0);
  } finally { await close(); }
});

test('add_note without confirm is a dry run and writes nothing', async () => {
  const { client, mock, close } = await connect({ allowWrites: true });
  try {
    const r = await client.callTool({ name: 'add_note', arguments: { deal_id: 1, content: 'hello' } });
    const out = parse(r);
    assert.strictEqual(out.dry_run, true);
    assert.strictEqual(mock.state.notesPosted.length, 0);
  } finally { await close(); }
});

test('add_note with confirm=true writes exactly once, with markup escaped', async () => {
  const { client, mock, close } = await connect({ allowWrites: true });
  try {
    const r = await client.callTool({ name: 'add_note', arguments: { deal_id: 1, content: '<img src=x onerror=alert(1)> chased client', confirm: true } });
    assert.strictEqual(parse(r).ok, true);
    assert.strictEqual(mock.state.notesPosted.length, 1);
    const posted = mock.state.notesPosted[0];
    assert.strictEqual(posted.deal_id, 1);
    assert.ok(!posted.content.includes('<img'));
    assert.ok(posted.content.includes('&lt;img'));
  } finally { await close(); }
});

test('Pipedrive being down surfaces as a safe tool error and is logged without secrets', async () => {
  const mock = await startMockPipedrive();
  const pipedrive = createPipedriveClient({ baseUrl: mock.url, token: 'wrong-token', sleep: async () => {} });
  const logs = [];
  const server = buildMcpServer({ pipedrive, now: () => NOW, log: (e) => logs.push(e) });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '1' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const r = await client.callTool({ name: 'get_open_deals', arguments: {} });
    assert.strictEqual(r.isError, true);
    assert.match(r.content[0].text, /HTTP 401/);
    assert.ok(logs.some((l) => l.event === 'tool' && l.name === 'get_open_deals' && l.ok === false));
    assert.ok(!JSON.stringify(logs).includes('wrong-token'));
  } finally { await client.close(); await mock.close(); }
});
