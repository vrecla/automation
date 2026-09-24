#!/usr/bin/env node
// Usage: node scripts/send-sample.js sample-transcripts/01-clean-routine.json [webhookUrl]
// Default URL is the n8n TEST webhook (click "Listen for test event" in n8n first).
// For the active/production webhook, use http://localhost:5678/webhook/call-transcript
const fs = require('fs');
const [file, url = 'http://localhost:5678/webhook-test/call-transcript'] = process.argv.slice(2);
if (!file) { console.error('usage: node scripts/send-sample.js <payload.json> [url]'); process.exit(1); }

(async () => {
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  console.log(res.status, await res.text());
})().catch((e) => { console.error('Request failed:', e.message); process.exit(1); });
