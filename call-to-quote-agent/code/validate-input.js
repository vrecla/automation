// NODE: "Validate Input"
// Purpose: reject a malformed webhook payload BEFORE spending an LLM call or touching the CRM.
// Throwing here fails the execution, which triggers the error-alert workflow.

function validateInput(body) {
  const b = body || {};
  const errors = [];

  const callId = typeof b.call_id === 'string' ? b.call_id.trim() : '';
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(callId)) {
    errors.push('call_id must be 3-64 chars: letters, digits, _ or -');
  }

  const transcript = typeof b.transcript === 'string' ? b.transcript.trim() : '';
  if (transcript.length < 50) errors.push('transcript is missing or too short (<50 chars)');
  if (transcript.length > 30000) errors.push('transcript is too long (>30000 chars)');

  const recordedAt = new Date(b.recorded_at);
  if (!b.recorded_at || Number.isNaN(recordedAt.getTime())) {
    errors.push('recorded_at must be a valid ISO date');
  }

  if (errors.length) throw new Error('Invalid webhook payload: ' + errors.join('; '));

  return {
    call_id: callId,
    transcript,
    recorded_at: recordedAt.toISOString(),
    caller_phone: typeof b.caller_phone === 'string' && b.caller_phone.trim() ? b.caller_phone.trim() : null,
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { validateInput };

if (typeof $input !== 'undefined') {
  const item = $input.first().json;
  const body = item.body !== undefined ? item.body : item; // webhook nests the payload under .body
  return [{ json: validateInput(body) }];
}
