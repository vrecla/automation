const test = require('node:test');
const assert = require('node:assert');
const { createPipedriveClient, PipedriveError } = require('../src/pipedrive');
const { PD_TOKEN, startMockPipedrive } = require('./helpers');

const noSleep = async () => {};

test('listOpenDeals follows cursors, requests v2 with the right params, and sends the token as a header', async () => {
  const mock = await startMockPipedrive();
  try {
    const pd = createPipedriveClient({ baseUrl: mock.url, token: PD_TOKEN, sleep: noSleep });
    const { deals, truncated } = await pd.listOpenDeals({ pageSize: 2 });
    assert.strictEqual(deals.length, 5);       // 5 open deals across 3 pages
    assert.strictEqual(truncated, false);
    const calls = mock.state.requests.filter((r) => r.path === '/api/v2/deals');
    assert.strictEqual(calls.length, 3);
    assert.strictEqual(calls[0].query.status, 'open');
    assert.match(calls[0].query.include_fields, /undone_activities_count/);
    assert.ok(calls.every((c) => !JSON.stringify(c).includes(PD_TOKEN)), 'token must never appear in a URL');
  } finally { await mock.close(); }
});

test('listOpenDeals stops at maxDeals and reports truncation', async () => {
  const mock = await startMockPipedrive();
  try {
    const pd = createPipedriveClient({ baseUrl: mock.url, token: PD_TOKEN, sleep: noSleep });
    const r = await pd.listOpenDeals({ pageSize: 2, maxDeals: 2 });
    assert.strictEqual(r.deals.length, 2);
    assert.strictEqual(r.truncated, true);
  } finally { await mock.close(); }
});

test('GET retries on 429 and honours the retry', async () => {
  const mock = await startMockPipedrive({ failFirst429: 2 });
  try {
    const slept = [];
    const pd = createPipedriveClient({ baseUrl: mock.url, token: PD_TOKEN, sleep: async (ms) => slept.push(ms) });
    const { deals } = await pd.listOpenDeals();
    assert.strictEqual(deals.length, 5);
    assert.strictEqual(slept.length, 2);
  } finally { await mock.close(); }
});

test('GET gives up after maxRetries with a clear error', async () => {
  const mock = await startMockPipedrive({ failFirst429: 99 });
  try {
    const pd = createPipedriveClient({ baseUrl: mock.url, token: PD_TOKEN, sleep: noSleep, maxRetries: 2 });
    await assert.rejects(() => pd.listOpenDeals(), (e) => e instanceof PipedriveError && e.status === 429 && /HTTP 429/.test(e.message));
    assert.strictEqual(mock.state.requests.length, 3, '1 try + 2 retries');
  } finally { await mock.close(); }
});

test('bad token gives a clean 401 error and does not leak the token', async () => {
  const mock = await startMockPipedrive();
  try {
    const pd = createPipedriveClient({ baseUrl: mock.url, token: 'secret-wrong-token-123', sleep: noSleep });
    await assert.rejects(() => pd.listOpenDeals(), (e) => e.status === 401 && !e.message.includes('secret-wrong-token-123'));
    assert.strictEqual(mock.state.requests.length, 1, '401 is not retried');
  } finally { await mock.close(); }
});

test('POST is NEVER retried (a retry could double-write)', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return new Response(JSON.stringify({ error: 'boom' }), { status: 500 }); };
  const pd = createPipedriveClient({ baseUrl: 'http://x', token: 't', fetchImpl, sleep: noSleep, maxRetries: 3 });
  await assert.rejects(() => pd.addNote(1, 'hello'), /HTTP 500/);
  assert.strictEqual(calls, 1);
});

test('times out slow responses', async () => {
  const fetchImpl = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const pd = createPipedriveClient({ baseUrl: 'http://x', token: 't', fetchImpl, sleep: noSleep, timeoutMs: 30, maxRetries: 0 });
  await assert.rejects(() => pd.getDeal(1), /timed out after 30ms/);
});

test('repeated pagination cursor aborts instead of looping forever', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ success: true, data: [{ id: 1, status: 'open' }], additional_data: { next_cursor: 'same' } }), { status: 200 });
  const pd = createPipedriveClient({ baseUrl: 'http://x', token: 't', fetchImpl, sleep: noSleep });
  await assert.rejects(() => pd.listOpenDeals(), /cursor repeated/);
});

test('client refuses to be created without a token', () => {
  assert.throws(() => createPipedriveClient({ baseUrl: 'http://x' }), /token is required/);
});
