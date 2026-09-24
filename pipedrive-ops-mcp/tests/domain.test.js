const test = require('node:test');
const assert = require('node:assert');
const d = require('../src/domain');
const { NOW, DEALS } = require('./helpers');

test('parseTime handles RFC3339, v1-style UTC strings, and junk', () => {
  assert.strictEqual(d.parseTime('2026-09-22T00:00:00Z'), Date.parse('2026-09-22T00:00:00Z'));
  assert.strictEqual(d.parseTime('2026-09-22 00:00:00'), Date.parse('2026-09-22T00:00:00Z'));
  assert.strictEqual(d.parseTime(null), null);
  assert.strictEqual(d.parseTime('not a date'), null);
});

test('daysIdle uses the most recent of update / stage change / add time', () => {
  assert.strictEqual(d.daysIdle(DEALS[0], NOW), 2);
  assert.strictEqual(d.daysIdle(DEALS[3], NOW), 54); // update_time null -> falls back to add_time
  assert.strictEqual(d.daysIdle({ add_time: '2026-09-01T00:00:00Z', stage_change_time: '2026-09-23T00:00:00Z' }, NOW), 1);
  assert.strictEqual(d.daysIdle({}, NOW), null);
  assert.strictEqual(d.daysIdle({ add_time: '2027-01-01T00:00:00Z' }, NOW), 0, 'future timestamps never give negative idle days');
});

test('isStale: open, no next step, idle >= N days', () => {
  assert.strictEqual(d.isStale(DEALS[1], NOW, 7), true);   // 23 days, nothing scheduled
  assert.strictEqual(d.isStale(DEALS[2], NOW, 7), false);  // only 4 days idle
  assert.strictEqual(d.isStale(DEALS[2], NOW, 3), true);
  assert.strictEqual(d.isStale(DEALS[0], NOW, 1), false);  // has an undone activity
  assert.strictEqual(d.isStale(DEALS[4], NOW, 7), false);  // next_activity_id set, though idle for weeks
  assert.strictEqual(d.isStale(DEALS[5], NOW, 7), false);  // won, not open
  assert.strictEqual(d.isStale({ status: 'open' }, NOW, 7), false, 'unknown times are never called stale');
});

test('computeFacts: counts, ids, values, and ordering', () => {
  const f = d.computeFacts(DEALS, NOW, 7);
  assert.strictEqual(f.open_count, 5);
  assert.deepStrictEqual(f.stale_ids, [2, 4]);
  assert.deepStrictEqual(f.stale.map((x) => x.id), [4, 2], 'longest idle first');
  assert.strictEqual(f.value_by_currency.AUD, 27722.9);
  assert.strictEqual(computeStaleAt3().length, 3);
  function computeStaleAt3() { return d.computeFacts(DEALS, NOW, 3).stale_ids; }
});

test('stripHtml removes markup, decodes entities, caps length', () => {
  assert.strictEqual(d.stripHtml('<b>Hi</b>&nbsp;there &amp; <i>you</i>'), 'Hi there & you');
  assert.strictEqual(d.stripHtml('x'.repeat(500), 50).length, 50);
  assert.strictEqual(d.stripHtml(null), '');
});

test('escapeHtml neutralises markup', () => {
  assert.strictEqual(d.escapeHtml('<script>"x"&</script>'), '&lt;script&gt;&quot;x&quot;&amp;&lt;/script&gt;');
});
