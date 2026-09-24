
// ---- n8n glue for node "Reconcile" (reconcile.js above is embedded verbatim) ----
if (typeof $input !== 'undefined') {
  const facts = $('Compute Facts').first().json;
  const raw = $input.first().json.output; // text produced by the AI Agent node
  let agent = null;
  let parseError = null;
  try { agent = extractJson(raw); } catch (e) { parseError = e.message; }

  const result = parseError
    ? { ok: false, problems: ['Could not parse agent output: ' + parseError] }
    : reconcile(agent, facts);

  const whenLabel = new Date().toLocaleDateString('en-AU', { timeZone: 'Australia/Melbourne', weekday: 'short', day: 'numeric', month: 'short' });
  return [{
    json: {
      ok: result.ok,
      problems: result.problems,
      text: result.ok ? buildDigestText(agent, facts, whenLabel) : null,
      agent_raw: String(raw == null ? '' : raw).slice(0, 1500),
      facts_summary: { open: facts.open_count, stale: facts.stale_count, stale_ids: facts.stale_ids },
    },
  }];
}
