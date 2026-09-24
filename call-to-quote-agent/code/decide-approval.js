// NODE: "Decide"
// Purpose: turn the approval form submission into one of three explicit states.
// The Wait node (resume: On Form Submitted) outputs the form fields, e.g. { Decision: 'Approve', submittedAt, formMode }.
// Anything that is not an explicit "Approve" (Reject, timeout with no submission, garbage) is treated as NOT approved.
//
// Why a form and not ?decision=approve links: n8n signs resume URLs (?signature=...). Appending our own query
// parameter to a signed URL invalidates it and n8n answers {"error":"Invalid token"}. The form keeps the URL untouched.

function decide(payload) {
  const d = String((payload && payload.Decision) || '').trim().toLowerCase();
  if (d === 'approve') return 'approved';
  if (d === 'reject') return 'rejected';
  return 'timed_out';
}

if (typeof module !== 'undefined' && module.exports) module.exports = { decide };

if (typeof $input !== 'undefined') {
  return [{ json: { decision: decide($input.first().json) } }];
}
