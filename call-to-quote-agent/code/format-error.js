// NODE (error workflow): "Format Alert"
// Purpose: turn n8n's Error Trigger payload into a readable Slack message.

function formatError(e) {
  const wf = (e.workflow && e.workflow.name) || 'unknown workflow';
  const ex = e.execution || {};
  const msg = (ex.error && ex.error.message) || 'no message';
  return [
    `:rotating_light: *${wf}* failed`,
    `Node: ${ex.lastNodeExecuted || 'unknown'}`,
    `Error: ${msg}`,
    `Execution: ${ex.url || ex.id || 'unknown'}`,
  ].join('\n');
}

if (typeof module !== 'undefined' && module.exports) module.exports = { formatError };

if (typeof $input !== 'undefined') {
  return [{ json: { text: formatError($input.first().json) } }];
}
