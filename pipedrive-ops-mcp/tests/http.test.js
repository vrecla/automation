// Full stack: real MCP client -> real HTTP server (auth, rate limit, body limit) -> fake Pipedrive.
const test = require('node:test');
const assert = require('node:assert');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { createServer } = require('../src/server');
const { loadConfig } = require('../src/config');
const { createPipedriveClient } = require('../src/pipedrive');
const { NOW, PD_TOKEN, startMockPipedrive } = require('./helpers');

const AUTH = 'test-auth-token-0123456789abcdef';

async function start(overrides = {}) {
  const mock = await startMockPipedrive();
  const config = { ...loadConfig({ PIPEDRIVE_API_TOKEN: PD_TOKEN, MCP_AUTH_TOKEN: AUTH, PIPEDRIVE_BASE_URL: mock.url }), ...overrides };
  const pipedrive = createPipedriveClient({ baseUrl: config.pipedriveBaseUrl, token: config.pipedriveToken, sleep: async () => {} });
  const logs = [];
  const server = createServer({ config, pipedrive, now: () => NOW, log: (e) => logs.push(e) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, logs, mock, close: async () => { await new Promise((r) => server.close(r)); await mock.close(); } };
}
const rpc = (method, params, id = 1) => JSON.stringify({ jsonrpc: '2.0', id, method, params });
const post = (base, body, token = AUTH) => fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body });

test('real MCP client: connect, list tools, call a tool over HTTP with a bearer token', async () => {
  const s = await start();
  try {
    const client = new Client({ name: 'n8n-like', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${s.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${AUTH}` } } }));
    const { tools } = await client.listTools();
    assert.strictEqual(tools.length, 4);
    const r = await client.callTool({ name: 'get_stale_deals', arguments: { days: 7 } });
    const out = JSON.parse(r.content[0].text);
    assert.deepStrictEqual(out.stale_deal_ids, [2, 4]);
    await client.close();
  } finally { await s.close(); }
});

test('rejects missing, malformed and wrong tokens with 401', async () => {
  const s = await start();
  try {
    const body = rpc('tools/list', {});
    assert.strictEqual((await post(s.base, body, null)).status, 401);
    assert.strictEqual((await post(s.base, body, 'wrong-token')).status, 401);
    assert.strictEqual((await post(s.base, body, AUTH.slice(0, -1))).status, 401);
    const basic = await fetch(`${s.base}/mcp`, { method: 'POST', headers: { authorization: `Basic ${AUTH}` }, body });
    assert.strictEqual(basic.status, 401);
    assert.strictEqual(s.mock.state.requests.length, 0, 'unauthenticated requests never reach Pipedrive');
  } finally { await s.close(); }
});

test('/health is open and reveals nothing; unknown paths 404; GET /mcp is 405 (after auth)', async () => {
  const s = await start();
  try {
    const h = await fetch(`${s.base}/health`);
    assert.strictEqual(h.status, 200);
    assert.deepStrictEqual(await h.json(), { ok: true });
    assert.strictEqual((await fetch(`${s.base}/admin`)).status, 404);
    assert.strictEqual((await fetch(`${s.base}/mcp`, { headers: { authorization: `Bearer ${AUTH}` } })).status, 405);
    assert.strictEqual((await fetch(`${s.base}/mcp`)).status, 401, 'unauthenticated probes learn nothing');
  } finally { await s.close(); }
});

test('malformed JSON gets a 400 JSON-RPC parse error; oversized body gets 413', async () => {
  const s = await start({ maxBodyBytes: 1000 });
  try {
    const bad = await post(s.base, '{not json');
    assert.strictEqual(bad.status, 400);
    assert.strictEqual((await bad.json()).error.code, -32700);
    const big = await post(s.base, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'x', params: { pad: 'a'.repeat(5000) } }));
    assert.strictEqual(big.status, 413);
    assert.deepStrictEqual(await big.json(), { error: 'Request body too large' });
  } finally { await s.close(); }
});

test('rate limit returns 429 after the configured number of authenticated requests', async () => {
  const s = await start({ rateLimitPerMinute: 3 });
  try {
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await post(s.base, rpc('ping', {}, i + 1))).status);
    assert.deepStrictEqual(statuses.slice(3), [429, 429]);
    assert.ok(statuses.slice(0, 3).every((c) => c === 200));
  } finally { await s.close(); }
});

test('add_note over HTTP is blocked by default even with confirm=true', async () => {
  const s = await start();
  try {
    const client = new Client({ name: 't', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${s.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${AUTH}` } } }));
    const r = await client.callTool({ name: 'add_note', arguments: { deal_id: 1, content: 'x', confirm: true } });
    assert.strictEqual(r.isError, true);
    assert.strictEqual(s.mock.state.notesPosted.length, 0);
    await client.close();
  } finally { await s.close(); }
});

test('logs never contain the auth token or the Pipedrive token', async () => {
  const s = await start();
  try {
    await post(s.base, rpc('tools/list', {}));
    await post(s.base, rpc('tools/list', {}), 'wrong');
    const all = JSON.stringify(s.logs);
    assert.ok(!all.includes(AUTH));
    assert.ok(!all.includes(PD_TOKEN));
    assert.ok(s.logs.some((l) => l.event === 'http' && l.status === 401));
  } finally { await s.close(); }
});

test('config fails closed: no auth token or a short one means the server will not start', () => {
  assert.throws(() => loadConfig({ PIPEDRIVE_API_TOKEN: 'x' }), /MCP_AUTH_TOKEN/);
  assert.throws(() => loadConfig({ PIPEDRIVE_API_TOKEN: 'x', MCP_AUTH_TOKEN: 'short' }), /at least 24/);
  assert.throws(() => loadConfig({ MCP_AUTH_TOKEN: AUTH }), /PIPEDRIVE_API_TOKEN/);
  const ok = loadConfig({ PIPEDRIVE_API_TOKEN: 'x', MCP_AUTH_TOKEN: AUTH });
  assert.strictEqual(ok.allowWrites, false, 'writes default to OFF');
  assert.strictEqual(loadConfig({ PIPEDRIVE_API_TOKEN: 'x', MCP_AUTH_TOKEN: AUTH, ALLOW_WRITES: 'true' }).allowWrites, true);
  assert.strictEqual(loadConfig({ PIPEDRIVE_API_TOKEN: 'x', MCP_AUTH_TOKEN: AUTH, ALLOW_WRITES: 'yes' }).allowWrites, false, 'only the exact string "true" enables writes');
});
