// NODE: "Resolve Org"
// Purpose: search-before-create so repeat callers from the same company don't create duplicate organisations.
// Input: the Pipedrive organisation search response. Context comes from the "Calculate Quote" node.

function resolveOrg(searchResponse, orgName) {
  const items = (searchResponse && searchResponse.data && searchResponse.data.items) || [];
  const wanted = String(orgName).trim().toLowerCase();
  const match = items.find((i) => i.item && String(i.item.name).trim().toLowerCase() === wanted);
  return match ? { org_id: match.item.id, needsCreate: false } : { org_id: null, needsCreate: true };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { resolveOrg };

if (typeof $input !== 'undefined') {
  const ctx = $('Calculate Quote').first().json;
  return [{ json: { ...ctx, ...resolveOrg($input.first().json, ctx.org_name) } }];
}
