const test = require('node:test');
const assert = require('node:assert');
const { resolveOrg } = require('../code/resolve-org.js');
const { buildPersonPayload } = require('../code/collect-org-id.js');
const { decide } = require('../code/decide-approval.js');
const { formatError } = require('../code/format-error.js');

test('resolveOrg finds an exact (case-insensitive) match, else asks to create', () => {
  const found = resolveOrg({ data: { items: [{ item: { id: 42, name: 'HARBOURVIEW body corporate' } }] } }, 'Harbourview Body Corporate');
  assert.deepStrictEqual(found, { org_id: 42, needsCreate: false });
  assert.deepStrictEqual(resolveOrg({ data: { items: [] } }, 'X'), { org_id: null, needsCreate: true });
  assert.deepStrictEqual(resolveOrg({ success: true, data: null }, 'X'), { org_id: null, needsCreate: true });
  // a fuzzy hit with a different name must NOT be reused
  assert.strictEqual(resolveOrg({ data: { items: [{ item: { id: 1, name: 'Harbourview Holdings' } }] } }, 'Harbourview Body Corporate').needsCreate, true);
});

test('person payload includes only the contact fields we have', () => {
  const p = buildPersonPayload({ caller_name: 'Sarah', caller_email: null, caller_phone: '0412345678' }, 7);
  assert.deepStrictEqual(p, { name: 'Sarah', org_id: 7, phone: [{ value: '0412345678', primary: true, label: 'work' }] });
  assert.strictEqual(buildPersonPayload({ caller_name: null }, 7).name, 'Unknown caller');
});

test('only an explicit Approve from the form counts as approved', () => {
  assert.strictEqual(decide({ Decision: 'Approve' }), 'approved');
  assert.strictEqual(decide({ Decision: ' approve ' }), 'approved');
  assert.strictEqual(decide({ Decision: 'Reject' }), 'rejected');
  assert.strictEqual(decide({}), 'timed_out');
  assert.strictEqual(decide(undefined), 'timed_out');
  assert.strictEqual(decide({ Decision: 'yes please' }), 'timed_out');
  assert.strictEqual(decide({ Decision: 'Approved-ish' }), 'timed_out');
});

test('error alert is readable', () => {
  const t = formatError({ workflow: { name: 'Call to Quote Agent' }, execution: { lastNodeExecuted: 'Claude Extract', error: { message: '401 unauthorized' }, url: 'http://n8n/execution/9' } });
  assert.match(t, /Call to Quote Agent/);
  assert.match(t, /Claude Extract/);
  assert.match(t, /401 unauthorized/);
  assert.match(formatError({}), /unknown workflow/);
});
