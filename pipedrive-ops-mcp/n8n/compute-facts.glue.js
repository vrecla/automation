
// ---- n8n glue for node "Compute Facts" (domain.js above is embedded verbatim) ----
if (typeof $input !== 'undefined') {
  const cfg = $('Config').first().json;
  const resp = $input.first().json;
  if (!resp || resp.success !== true || !Array.isArray(resp.data)) {
    throw new Error('Unexpected Pipedrive response while fetching open deals');
  }
  if (resp.additional_data && resp.additional_data.next_cursor) {
    throw new Error('More than 500 open deals: this workflow does not page the ground-truth fetch yet, so it cannot verify the digest');
  }
  const staleDays = Number(cfg.staleDays);
  if (!Number.isInteger(staleDays) || staleDays < 1) throw new Error('Config.staleDays must be a whole number >= 1');
  return [{ json: computeFacts(resp.data, Date.now(), staleDays) }];
}
