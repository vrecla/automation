// NODE: "Validate Extraction"
// Purpose: NEVER trust the model's output. Parse it, check it against business rules, and check that the
// facts it returned are actually present in the transcript (catches hallucinated emails/phones/suburbs).
// Output: { valid, errors[], warnings[], data }. Invalid records go to a Slack review queue, not the CRM.

// Keep these enums in sync with the tool schema in build-claude-request.js
const HAZARD_TYPES = ['lifted_slab', 'crack', 'gap', 'spalling', 'other'];
const SEVERITIES = ['low', 'medium', 'high'];
const URGENCIES = ['routine', 'urgent'];
const SERVICE_STATES = ['VIC', 'NSW', 'QLD'];
const POSTCODE_RANGES = {
  VIC: [[3000, 3999], [8000, 8999]],
  NSW: [[2000, 2999]],
  QLD: [[4000, 4999], [9000, 9999]],
};
const MAX_QTY_PER_LINE = 100;
const MAX_TOTAL_HAZARDS = 500;

const digitsOnly = (s) => String(s || '').replace(/\D/g, '');
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const nonEmpty = (s) => typeof s === 'string' && s.trim().length > 0;

function postcodeMatchesState(postcode, state) {
  const n = Number(postcode);
  return (POSTCODE_RANGES[state] || []).some(([lo, hi]) => n >= lo && n <= hi);
}

function validateExtraction(response, ctx = {}) {
  const errors = [];
  const warnings = [];
  const transcript = ctx.transcript || '';
  const minConfidence = Number.isFinite(ctx.minConfidence) ? ctx.minConfidence : 0.7;

  // 1. Did we get structured output at all?
  const block = (response && Array.isArray(response.content))
    ? response.content.find((c) => c.type === 'tool_use' && c.name === 'record_call')
    : null;
  if (!block || !block.input) {
    return { valid: false, errors: ['Model returned no structured record_call output'], warnings, data: null };
  }
  if (response.stop_reason === 'max_tokens') {
    return { valid: false, errors: ['Model output was truncated (max_tokens)'], warnings, data: null };
  }
  const x = block.input;

  // 2. Address / service area
  if (!nonEmpty(x.address_line)) errors.push('address_line is missing');
  if (!nonEmpty(x.suburb)) errors.push('suburb is missing');
  const state = String(x.state || '').toUpperCase();
  if (!SERVICE_STATES.includes(state)) errors.push(`Outside service area (state: ${x.state || 'unknown'})`);
  if (nonEmpty(x.postcode)) {
    if (!/^\d{4}$/.test(x.postcode.trim())) errors.push(`postcode "${x.postcode}" is not 4 digits`);
    else if (SERVICE_STATES.includes(state) && !postcodeMatchesState(x.postcode.trim(), state)) {
      errors.push(`postcode ${x.postcode} does not match state ${state}`);
    }
  } else {
    warnings.push('postcode not provided');
  }

  // 3. Contact details: need at least one way to reach the caller
  const phone = nonEmpty(x.caller_phone) ? x.caller_phone.trim() : (ctx.callerPhone || null);
  const email = nonEmpty(x.caller_email) ? x.caller_email.trim() : null;
  if (!phone && !email) errors.push('No phone or email for the caller');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push(`caller_email "${email}" is not a valid email`);
  if (phone) {
    const d = digitsOnly(phone).length;
    if (d < 8 || d > 15) errors.push(`caller_phone "${phone}" does not look like a phone number`);
  }

  // 4. Hazards
  if (!Array.isArray(x.hazards) || x.hazards.length === 0) {
    errors.push('No hazards extracted');
  } else {
    let total = 0;
    x.hazards.forEach((h, i) => {
      if (!HAZARD_TYPES.includes(h.type)) errors.push(`hazard ${i + 1}: unknown type "${h.type}"`);
      if (!SEVERITIES.includes(h.severity)) errors.push(`hazard ${i + 1}: unknown severity "${h.severity}"`);
      if (!Number.isInteger(h.quantity) || h.quantity < 1 || h.quantity > MAX_QTY_PER_LINE) {
        errors.push(`hazard ${i + 1}: quantity must be a whole number 1-${MAX_QTY_PER_LINE}`);
      } else {
        total += h.quantity;
      }
    });
    if (total > MAX_TOTAL_HAZARDS) errors.push(`Total hazards ${total} exceeds sanity limit ${MAX_TOTAL_HAZARDS}`);
  }
  if (!URGENCIES.includes(x.urgency)) errors.push(`urgency must be one of ${URGENCIES.join('/')}`);

  // 5. Confidence and self-reported gaps
  if (typeof x.confidence !== 'number' || x.confidence < minConfidence) {
    errors.push(`Low confidence (${x.confidence}); threshold is ${minConfidence}`);
  }
  // The model's own confidence score is not a reliable safeguard (it can rate itself 0.8 on a vague call),
  // so ANY field it admits is unclear sends the record to a human, whatever the score.
  const unclear = Array.isArray(x.unclear_fields) ? x.unclear_fields : [];
  if (unclear.length) errors.push('Model flagged unclear details, needs a human to confirm: ' + unclear.join(', '));

  // 6. Grounding: every contact fact must actually appear in the transcript
  const t = norm(transcript);
  if (transcript) {
    if (nonEmpty(x.suburb) && !t.includes(norm(x.suburb))) errors.push(`suburb "${x.suburb}" not found in transcript`);
    if (nonEmpty(x.postcode) && !t.includes(x.postcode.trim())) errors.push(`postcode "${x.postcode}" not found in transcript`);
    if (email && !t.includes(email.toLowerCase())) errors.push(`email "${email}" not found in transcript`);
    if (nonEmpty(x.caller_phone)) {
      const tail = digitsOnly(x.caller_phone).slice(-8);
      const inTranscript = digitsOnly(transcript).includes(tail);
      const matchesMeta = ctx.callerPhone && digitsOnly(ctx.callerPhone).slice(-8) === tail;
      if (!inTranscript && !matchesMeta) errors.push(`phone "${x.caller_phone}" not found in transcript or call metadata`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    data: {
      caller_name: nonEmpty(x.caller_name) ? x.caller_name.trim() : null,
      caller_company: nonEmpty(x.caller_company) ? x.caller_company.trim() : null,
      caller_email: email,
      caller_phone: phone,
      address_line: nonEmpty(x.address_line) ? x.address_line.trim() : null,
      suburb: nonEmpty(x.suburb) ? x.suburb.trim() : null,
      state,
      postcode: nonEmpty(x.postcode) ? x.postcode.trim() : null,
      hazards: Array.isArray(x.hazards) ? x.hazards : [],
      urgency: x.urgency,
      notes: nonEmpty(x.notes) ? x.notes.trim() : null,
      unclear_fields: unclear,
      confidence: x.confidence,
    },
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { validateExtraction };

if (typeof $input !== 'undefined') {
  const meta = $('Validate Input').first().json;
  const cfg = $('Config').first().json;
  const result = validateExtraction($input.first().json, {
    transcript: meta.transcript,
    callerPhone: meta.caller_phone,
    minConfidence: Number(cfg.minConfidence),
  });
  const { transcript, ...metaWithoutTranscript } = meta; // don't carry the big transcript downstream
  return [{ json: { ...metaWithoutTranscript, ...result } }];
}
