// Configuration is read once at startup and FAILS CLOSED: the server refuses to start without an auth token,
// so it can never be deployed accidentally open to the internet.

function loadConfig(env = process.env) {
  const errors = [];
  if (!env.PIPEDRIVE_API_TOKEN) errors.push('PIPEDRIVE_API_TOKEN is required');
  if (!env.MCP_AUTH_TOKEN || env.MCP_AUTH_TOKEN.length < 24) {
    errors.push('MCP_AUTH_TOKEN is required and must be at least 24 characters');
  }
  if (errors.length) throw new Error('Invalid configuration: ' + errors.join('; '));

  return {
    port: Number(env.PORT) || 3000,
    pipedriveToken: env.PIPEDRIVE_API_TOKEN,
    authToken: env.MCP_AUTH_TOKEN,
    pipedriveBaseUrl: env.PIPEDRIVE_BASE_URL || 'https://api.pipedrive.com',
    // Writes are OFF unless explicitly enabled. Even then, add_note also needs confirm=true per call.
    allowWrites: env.ALLOW_WRITES === 'true',
    rateLimitPerMinute: Number(env.RATE_LIMIT_PER_MINUTE) || 120,
    maxBodyBytes: 1_000_000,
  };
}

module.exports = { loadConfig };
