const test = require('node:test');
const assert = require('node:assert');
const { extractJson, reconcile, sanitizeForSlack, buildDigestText, money } = require('../src/reconcile');
const { computeFacts } = require('../src/domain');
const { NOW, DEALS } = require('./helpers');

const facts = computeFacts(DEALS, NOW, 7); // open 5, stale [2,4]
const goodAgent = { headline: 'Two deals need a nudge today.', open_deals_count: 5, stale_deals_count: 2, stale_deal_ids: [4, 2], follow_ups: [{ deal_id: 2, action: 'Phone the client and confirm the quote' }] };

test('extractJson tolerates code fences and chatter around the JSON', () => {
  assert.deepStrictEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepStrictEqual(extractJson('Here you go: {"a":{"b":2}} thanks'), { a: { b: 2 } });
  assert.throws(() => extractJson('no json here'), /did not return a JSON object/);
  assert.throws(() => extractJson('{broken'), /JSON object/);
  assert.throws(() => extractJson('{"a": nope}'));
});

test('a correct digest reconciles', () => {
  const r = reconcile(goodAgent, facts);
  assert.deepStrictEqual(r, { ok: true, problems: [] });
});

test('wrong counts are caught', () => {
  assert.strictEqual(reconcile({ ...goodAgent, open_deals_count: 6 }, facts).ok, false);
  const r = reconcile({ ...goodAgent, stale_deals_count: 3 }, facts);
  assert.ok(r.problems.some((p) => /stale_deals_count: agent said 3/.test(p)));
});

test('wrong / missing / hallucinated stale ids are caught', () => {
  assert.ok(reconcile({ ...goodAgent, stale_deal_ids: [2] }, facts).problems.some((p) => /stale_deal_ids differ/.test(p)));
  assert.ok(reconcile({ ...goodAgent, stale_deal_ids: [2, 4, 99] }, facts).problems.some((p) => /differ/.test(p)));
  assert.ok(reconcile({ ...goodAgent, stale_deal_ids: 'two and four' }, facts).problems.some((p) => /not a list of integers/.test(p)));
  assert.ok(reconcile({ ...goodAgent, stale_deal_ids: ['2', '4'] }, facts).ok === false, 'strings are not integers');
});

test('follow-ups about non-existent or closed deals are caught', () => {
  assert.ok(reconcile({ ...goodAgent, follow_ups: [{ deal_id: 6, action: 'x' }] }, facts).problems.some((p) => /not an open deal/.test(p)));
  assert.ok(reconcile({ ...goodAgent, follow_ups: [{ deal_id: 12345, action: 'x' }] }, facts).ok === false);
  assert.ok(reconcile({ ...goodAgent, follow_ups: [null] }, facts).ok === false);
});

test('missing headline / non-object output is caught', () => {
  assert.ok(reconcile({ ...goodAgent, headline: '' }, facts).problems.some((p) => /headline/.test(p)));
  assert.strictEqual(reconcile(null, facts).ok, false);
  assert.strictEqual(reconcile('text', facts).ok, false);
});

test('Slack text can never ping a channel or inject links, even from hostile CRM titles or model output', () => {
  assert.strictEqual(sanitizeForSlack('<!channel> hi <https://evil.example|click> @here @everyone', 200), 'hi here everyone');
  assert.strictEqual(sanitizeForSlack('Old lead <b>never touched</b>', 200), 'Old lead never touched');
  assert.strictEqual(sanitizeForSlack('a < b > c', 200).includes('<'), false);
  const hostile = { ...goodAgent, headline: '<!channel> URGENT @channel', follow_ups: [{ deal_id: 4, action: '<@U123> pay <http://x|now>' }] };
  const text = buildDigestText(hostile, facts, 'Thu 24 Sep');
  assert.ok(!/[<>]/.test(text), 'no angle brackets survive');
  assert.ok(!/@(channel|here|everyone)/i.test(text));
});

test('digest numbers come from the facts, not from the model text', () => {
  const text = buildDigestText({ ...goodAgent, headline: 'We have 999 stale deals!' }, facts, 'Thu 24 Sep');
  assert.match(text, /Open deals: \*5\*/);
  assert.match(text, /AUD 27,722\.90/);
  assert.match(text, /Stale \(no next step, idle 7\+ days\): \*2\*/);
  assert.match(text, /#4 Old lead never touched channel \(idle 54d\)/);
  assert.match(text, /#2 Footpath repairs - 118 Bellair Street/);
  assert.match(text, /verified against Pipedrive data/);
});

test('money formatting', () => {
  assert.strictEqual(money(27722.9), '27,722.90');
  assert.strictEqual(money(0), '0.00');
  assert.strictEqual(money(1234567.891), '1,234,567.89');
});
