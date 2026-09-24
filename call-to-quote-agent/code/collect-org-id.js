// NODE: "Collect Org ID"
// Purpose: two branches (org existed / org created) rejoin here. We read the id from whichever branch ran,
// and build the Pipedrive person payload.

function buildPersonPayload(data, orgId) {
  const payload = { name: data.caller_name || 'Unknown caller', org_id: orgId };
  if (data.caller_email) payload.email = [{ value: data.caller_email, primary: true, label: 'work' }];
  if (data.caller_phone) payload.phone = [{ value: data.caller_phone, primary: true, label: 'work' }];
  return payload;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { buildPersonPayload };

if (typeof $input !== 'undefined') {
  const ctx = $('Resolve Org').first().json;
  // $('Create Org') is only touched when that branch actually ran.
  const orgId = ctx.needsCreate ? $('Create Org').first().json.data.id : ctx.org_id;
  return [{ json: { ...ctx, org_id: orgId, person_payload: buildPersonPayload(ctx.data, orgId) } }];
}
