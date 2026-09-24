// HTTP front door for the MCP server (MCP "Streamable HTTP" transport, stateless mode).
//  - /health           : unauthenticated liveness probe (returns nothing sensitive)
//  - POST /mcp         : MCP endpoint, requires `Authorization: Bearer <MCP_AUTH_TOKEN>`
// Stateless = a fresh MCP server per request. No sessions to lose on restart, and it scales horizontally.

const http = require('node:http');
const crypto = require('node:crypto');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { loadConfig } = require('./config');
const { createPipedriveClient } = require('./pipedrive');
const { buildMcpServer } = require('./mcp');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();

function createRateLimiter(limitPerMinute, now = () => Date.now()) {
  let windowStart = now();
  let count = 0;
  return function allow() {
    const t = now();
    if (t - windowStart >= 60_000) { windowStart = t; count = 0; }
    count += 1;
    return count <= limitPerMinute;
  };
}

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...extraHeaders });
  res.end(payload);
}
const rpcError = (code, message) => ({ jsonrpc: '2.0', error: { code, message }, id: null });

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (c) => {
      if (tooLarge) return; // drop the rest; the caller answers 413 and closes the connection
      size += c.length;
      if (size > maxBytes) { tooLarge = true; chunks.length = 0; reject(Object.assign(new Error('too large'), { code: 'TOO_LARGE' })); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

function createServer({ config, pipedrive, now = () => Date.now(), log = (e) => console.log(JSON.stringify(e)) }) {
  const tokenDigest = sha256(config.authToken);
  const allow = createRateLimiter(config.rateLimitPerMinute);
  const isAuthorized = (req) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    return Boolean(m) && crypto.timingSafeEqual(sha256(m[1]), tokenDigest); // constant-time compare
  };

  return http.createServer(async (req, res) => {
    const started = Date.now();
    const path = (req.url || '').split('?')[0];
    res.on('finish', () => log({ event: 'http', method: req.method, path, status: res.statusCode, ms: Date.now() - started }));

    try {
      if (path === '/health' && req.method === 'GET') return sendJson(res, 200, { ok: true });

      if (path !== '/mcp') return sendJson(res, 404, { error: 'Not found' });
      if (!isAuthorized(req)) return sendJson(res, 401, { error: 'Unauthorized' }, { 'www-authenticate': 'Bearer' });
      if (!allow()) return sendJson(res, 429, { error: 'Too many requests' }, { 'retry-after': '60' });
      if (req.method !== 'POST') return sendJson(res, 405, rpcError(-32000, 'Method not allowed (stateless server: use POST)'), { allow: 'POST' });

      let body;
      try {
        body = JSON.parse(await readBody(req, config.maxBodyBytes));
      } catch (err) {
        if (err && err.code === 'TOO_LARGE') {
          res.on('finish', () => req.destroy());
          return sendJson(res, 413, { error: 'Request body too large' }, { connection: 'close' });
        }
        return sendJson(res, 400, rpcError(-32700, 'Parse error'));
      }

      const mcp = buildMcpServer({ pipedrive, allowWrites: config.allowWrites, now, log });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { transport.close(); mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      log({ event: 'error', message: err && err.message });
      if (!res.headersSent) sendJson(res, 500, rpcError(-32603, 'Internal server error'));
    }
  });
}

function main() {
  const config = loadConfig();
  const pipedrive = createPipedriveClient({ baseUrl: config.pipedriveBaseUrl, token: config.pipedriveToken });
  const server = createServer({ config, pipedrive });
  server.listen(config.port, '0.0.0.0', () => {
    console.log(JSON.stringify({ event: 'listening', port: config.port, writes_enabled: config.allowWrites }));
  });
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}

if (require.main === module) {
  try { main(); } catch (err) { console.error(err.message); process.exit(1); }
}

module.exports = { createServer, createRateLimiter };
