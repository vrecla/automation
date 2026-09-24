#!/usr/bin/env node
// Checks a running server end to end with a real MCP client (use after deploying).
//   MCP_URL=https://your-service.onrender.com/mcp MCP_AUTH_TOKEN=... node scripts/smoke.js
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const url = process.env.MCP_URL;
const token = process.env.MCP_AUTH_TOKEN;
if (!url || !token) { console.error('Set MCP_URL and MCP_AUTH_TOKEN'); process.exit(1); }

(async () => {
  const client = new Client({ name: 'smoke', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  const { tools } = await client.listTools();
  console.log('tools:', tools.map((t) => t.name).join(', '));
  const r = await client.callTool({ name: 'get_open_deals', arguments: { limit: 3 } });
  console.log(r.isError ? 'ERROR:' : 'get_open_deals ->', r.content[0].text.slice(0, 600));
  await client.close();
  process.exit(r.isError ? 1 : 0);
})().catch((e) => { console.error('Smoke test failed:', e.message); process.exit(1); });
