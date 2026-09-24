#!/usr/bin/env node
// Builds the importable n8n workflow JSON files from the source in /code.
// Why a build step: the JavaScript lives in real .js files (testable, diffable, editable in Claude Code),
// and this script embeds it into the Code nodes. Edit code/*.js, run `npm run build`, re-import.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const readCode = (f) => fs.readFileSync(path.join(ROOT, 'code', f), 'utf8');
const uuid = (seed) => {
  const h = crypto.createHash('md5').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

function newWorkflow(name) {
  const nodes = [];
  const connections = {};
  return {
    nodes, connections, name,
    add(nodeName, type, typeVersion, parameters, position, extra = {}) {
      nodes.push({ parameters, id: uuid(name + nodeName), name: nodeName, type, typeVersion, position, ...extra });
      return nodeName;
    },
    link(from, to, outputIndex = 0) {
      connections[from] = connections[from] || { main: [] };
      while (connections[from].main.length <= outputIndex) connections[from].main.push([]);
      connections[from].main[outputIndex].push({ node: to, type: 'main', index: 0 });
    },
    toJSON(settings = {}) {
      return { name, nodes, connections, active: false, settings: { executionOrder: 'v1', ...settings }, meta: { templateCredsSetupCompleted: false } };
    },
  };
}

// ---------- node helpers ----------
const codeNode = (file) => ({ mode: 'runOnceForAllItems', language: 'javaScript', jsCode: readCode(file) });

const setNode = (fields) => ({
  assignments: { assignments: fields.map((f, i) => ({ id: `f${i}`, name: f.name, value: f.value, type: f.type || 'string' })) },
  includeOtherFields: true,
  options: {},
});

const ifNode = (leftExpr, operator, rightValue = '') => ({
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
    conditions: [{ id: uuid(leftExpr + operator.operation), leftValue: leftExpr, rightValue, operator }],
    combinator: 'and',
  },
  options: {},
});
const isTrue = { type: 'boolean', operation: 'true', singleValue: true };
const equalsStr = { type: 'string', operation: 'equals' };

const PIPEDRIVE_CRED = { httpHeaderAuth: { id: 'REPLACE_ME', name: 'Pipedrive API Token' } };
const ANTHROPIC_CRED = { httpHeaderAuth: { id: 'REPLACE_ME', name: 'Anthropic API Key' } };

function http({ method = 'GET', url, qs, body, headers, retry = false, timeout = 30000, authenticated = true }) {
  const p = { method, url, options: { timeout } };
  if (authenticated) { p.authentication = 'genericCredentialType'; p.genericAuthType = 'httpHeaderAuth'; }
  if (headers) {
    p.sendHeaders = true;
    p.headerParameters = { parameters: Object.entries(headers).map(([name, value]) => ({ name, value })) };
  }
  if (qs) {
    p.sendQuery = true;
    p.queryParameters = { parameters: Object.entries(qs).map(([name, value]) => ({ name, value })) };
  }
  if (body) { p.sendBody = true; p.specifyBody = 'json'; p.jsonBody = body; }
  return p;
}
// Retries are ONLY enabled on idempotent calls (GET searches and the Claude extraction).
// POSTs that create records (org/person/deal/note) are never blindly retried: a retry could create duplicates.
const RETRY = { retryOnFail: true, maxTries: 3, waitBetweenTries: 3000 };

// Pipedrive API v2 for deals / organisations / persons / activities (their v1 versions are out of support since 1 Aug 2026).
// Notes have no v2 endpoint, so they stay on /v1/notes, which is not on Pipedrive's deprecation list.
const PD = 'https://api.pipedrive.com/api/v2';
const PD_NOTES = 'https://api.pipedrive.com/v1/notes';
const dealCtx = "$('Collect Org ID').first().json";

// =====================================================================
// MAIN WORKFLOW
// =====================================================================
function buildMain() {
  const w = newWorkflow('Call to Quote Agent');
  const X = 260;
  let x = 0;
  const pos = (row = 0, dx = X) => [(x += dx), 300 + row * 220];

  w.add('Call Transcript Webhook', 'n8n-nodes-base.webhook', 2,
    { httpMethod: 'POST', path: 'call-transcript', responseMode: 'onReceived', options: {} },
    pos(0, 0), { webhookId: uuid('call-transcript-webhook') });

  w.add('Config', 'n8n-nodes-base.set', 3.4, setNode([
    { name: 'slackWebhookUrl', value: 'PASTE_SLACK_INCOMING_WEBHOOK_URL' },
    { name: 'claudeModel', value: 'claude-haiku-4-5-20251001' },
    { name: 'minConfidence', value: 0.7, type: 'number' },
  ]), pos());

  w.add('Validate Input', 'n8n-nodes-base.code', 2, codeNode('validate-input.js'), pos());

  w.add('Search Existing Deal', 'n8n-nodes-base.httpRequest', 4.2,
    http({ url: `${PD}/deals/search`, qs: { term: '={{ $json.call_id }}', limit: '10' } }),
    pos(), { credentials: PIPEDRIVE_CRED, ...RETRY });

  w.add('Is Duplicate?', 'n8n-nodes-base.if', 2.2,
    ifNode("={{ (($json.data && $json.data.items) || []).some(i => ((i.item && i.item.title) || '').includes($('Validate Input').first().json.call_id)) }}", isTrue),
    pos());

  w.add('Stop - Duplicate', 'n8n-nodes-base.noOp', 1, {}, [x + X, 300 + 220]);

  w.add('Build Claude Request', 'n8n-nodes-base.code', 2, codeNode('build-claude-request.js'), pos());

  w.add('Claude Extract', 'n8n-nodes-base.httpRequest', 4.2,
    http({
      method: 'POST', url: 'https://api.anthropic.com/v1/messages',
      headers: { 'anthropic-version': '2023-06-01' },
      body: '={{ JSON.stringify($json.claudeBody) }}', timeout: 60000,
    }),
    pos(), { credentials: ANTHROPIC_CRED, ...RETRY });

  w.add('Validate Extraction', 'n8n-nodes-base.code', 2, codeNode('validate-extraction.js'), pos());

  w.add('Extraction Valid?', 'n8n-nodes-base.if', 2.2, ifNode('={{ $json.valid }}', isTrue), pos());

  w.add('Slack - Needs Review', 'n8n-nodes-base.httpRequest', 4.2,
    http({
      method: 'POST', url: "={{ $('Config').first().json.slackWebhookUrl }}", authenticated: false,
      body: "={{ JSON.stringify({ text: ':warning: Call ' + $('Validate Extraction').first().json.call_id + ' needs human review, nothing was written to Pipedrive.\\n- ' + $('Validate Extraction').first().json.errors.join('\\n- ') }) }}",
    }),
    [x + X, 300 + 220]);

  w.add('Calculate Quote', 'n8n-nodes-base.code', 2, codeNode('calculate-quote.js'), pos());

  w.add('Search Org', 'n8n-nodes-base.httpRequest', 4.2,
    http({ url: `${PD}/organizations/search`, qs: { term: '={{ $json.org_name }}', exact_match: 'true', limit: '5' } }),
    pos(), { credentials: PIPEDRIVE_CRED, ...RETRY });

  w.add('Resolve Org', 'n8n-nodes-base.code', 2, codeNode('resolve-org.js'), pos());

  w.add('Needs New Org?', 'n8n-nodes-base.if', 2.2, ifNode('={{ $json.needsCreate }}', isTrue), pos());

  w.add('Create Org', 'n8n-nodes-base.httpRequest', 4.2,
    http({ method: 'POST', url: `${PD}/organizations`, body: '={{ JSON.stringify({ name: $json.org_name }) }}' }),
    pos(1), { credentials: PIPEDRIVE_CRED });

  w.add('Collect Org ID', 'n8n-nodes-base.code', 2, codeNode('collect-org-id.js'), pos(0));

  w.add('Create Person', 'n8n-nodes-base.httpRequest', 4.2,
    http({ method: 'POST', url: `${PD}/persons`, body: '={{ JSON.stringify($json.person_payload) }}' }),
    pos(), { credentials: PIPEDRIVE_CRED });

  w.add('Create Deal', 'n8n-nodes-base.httpRequest', 4.2,
    http({
      method: 'POST', url: `${PD}/deals`,
      body: `={{ JSON.stringify({ title: ${dealCtx}.deal_title, value: ${dealCtx}.quote.ex_gst_cents / 100, currency: 'AUD', person_id: $json.data.id, org_id: ${dealCtx}.org_id }) }}`,
    }),
    pos(), { credentials: PIPEDRIVE_CRED });

  w.add('Add Draft Note', 'n8n-nodes-base.httpRequest', 4.2,
    http({
      method: 'POST', url: PD_NOTES,
      body: `={{ JSON.stringify({ content: ${dealCtx}.quote_html, deal_id: $json.data.id }) }}`,
    }),
    pos(), { credentials: PIPEDRIVE_CRED });

  w.add('Slack - Approval Request', 'n8n-nodes-base.httpRequest', 4.2,
    http({
      method: 'POST', url: "={{ $('Config').first().json.slackWebhookUrl }}", authenticated: false,
      // The form URL is used exactly as n8n generates it. Never append query parameters to it: it is signed.
      body: `={{ JSON.stringify({ text: 'Quote ready for approval (Pipedrive deal #' + $('Create Deal').first().json.data.id + ')\\n' + ${dealCtx}.quote_text + '\\n<' + $execution.resumeFormUrl + '|Open approval form (Approve / Reject)>' }) }}`,
    }),
    pos());

  w.add('Wait - Approval', 'n8n-nodes-base.wait', 1.1, {
    resume: 'form',
    formTitle: 'Approve draft quote?',
    formDescription: 'Approve to mark the draft quote ready to send. Reject to stop and leave it for a human to follow up. If nobody responds within 24 hours it is treated as not approved.',
    formFields: {
      values: [{
        fieldLabel: 'Decision', fieldType: 'dropdown', requiredField: true,
        fieldOptions: { values: [{ option: 'Approve' }, { option: 'Reject' }] },
      }],
    },
    responseMode: 'onReceived', options: {},
    limitWaitTime: true, limitType: 'afterTimeInterval', resumeAmount: 24, resumeUnit: 'hours',
  }, pos(), { webhookId: uuid('wait-approval') });

  w.add('Decide', 'n8n-nodes-base.code', 2, codeNode('decide-approval.js'), pos());

  w.add('Approved?', 'n8n-nodes-base.if', 2.2, ifNode('={{ $json.decision }}', equalsStr, 'approved'), pos());

  w.add('Create Follow-up Activity', 'n8n-nodes-base.httpRequest', 4.2,
    http({
      method: 'POST', url: `${PD}/activities`,
      body: "={{ JSON.stringify({ subject: 'Send approved quote to client', type: 'task', deal_id: $('Create Deal').first().json.data.id, due_date: new Date().toISOString().slice(0, 10), note: 'Quote approved via Slack. Review and send.' }) }}",
    }),
    [x + X, 300], { credentials: PIPEDRIVE_CRED });

  w.add('Add Rejection Note', 'n8n-nodes-base.httpRequest', 4.2,
    http({
      method: 'POST', url: PD_NOTES,
      body: "={{ JSON.stringify({ content: '<b>Draft quote NOT approved</b> (' + $json.decision + '). Needs human follow-up.', deal_id: $('Create Deal').first().json.data.id }) }}",
    }),
    [x + X, 300 + 220], { credentials: PIPEDRIVE_CRED });

  // ---- connections ----
  const chain = [
    'Call Transcript Webhook', 'Config', 'Validate Input', 'Search Existing Deal', 'Is Duplicate?',
  ];
  for (let i = 0; i < chain.length - 1; i++) w.link(chain[i], chain[i + 1]);
  w.link('Is Duplicate?', 'Stop - Duplicate', 0);
  w.link('Is Duplicate?', 'Build Claude Request', 1);
  w.link('Build Claude Request', 'Claude Extract');
  w.link('Claude Extract', 'Validate Extraction');
  w.link('Validate Extraction', 'Extraction Valid?');
  w.link('Extraction Valid?', 'Calculate Quote', 0);
  w.link('Extraction Valid?', 'Slack - Needs Review', 1);
  w.link('Calculate Quote', 'Search Org');
  w.link('Search Org', 'Resolve Org');
  w.link('Resolve Org', 'Needs New Org?');
  w.link('Needs New Org?', 'Create Org', 0);
  w.link('Needs New Org?', 'Collect Org ID', 1);
  w.link('Create Org', 'Collect Org ID');
  w.link('Collect Org ID', 'Create Person');
  w.link('Create Person', 'Create Deal');
  w.link('Create Deal', 'Add Draft Note');
  w.link('Add Draft Note', 'Slack - Approval Request');
  w.link('Slack - Approval Request', 'Wait - Approval');
  w.link('Wait - Approval', 'Decide');
  w.link('Decide', 'Approved?');
  w.link('Approved?', 'Create Follow-up Activity', 0);
  w.link('Approved?', 'Add Rejection Note', 1);

  return w;
}

// =====================================================================
// ERROR WORKFLOW (set as "Error Workflow" in the main workflow's settings)
// =====================================================================
function buildError() {
  const w = newWorkflow('Call to Quote - Error Alert');
  w.add('Error Trigger', 'n8n-nodes-base.errorTrigger', 1, {}, [0, 300]);
  w.add('Config', 'n8n-nodes-base.set', 3.4, setNode([
    { name: 'slackWebhookUrl', value: 'PASTE_SLACK_INCOMING_WEBHOOK_URL' },
  ]), [260, 300]);
  w.add('Format Alert', 'n8n-nodes-base.code', 2, codeNode('format-error.js'), [520, 300]);
  w.add('Slack - Alert', 'n8n-nodes-base.httpRequest', 4.2,
    http({
      method: 'POST', url: "={{ $('Config').first().json.slackWebhookUrl }}", authenticated: false,
      body: '={{ JSON.stringify({ text: $json.text }) }}',
    }), [780, 300]);
  w.link('Error Trigger', 'Config');
  w.link('Config', 'Format Alert');
  w.link('Format Alert', 'Slack - Alert');
  return w;
}

function write(file, wf) {
  fs.writeFileSync(path.join(ROOT, 'workflows', file), JSON.stringify(wf.toJSON(), null, 2) + '\n');
  console.log('wrote workflows/' + file);
}

write('call-to-quote.json', buildMain());
write('error-alert.json', buildError());
