// Embedded (by scripts/build-workflow.js) into the n8n "Reconcile" Code node.
// The agent's digest is checked against numbers computed by plain code from Pipedrive data, BEFORE anything is
// posted. If they disagree, the digest is withheld and a human is told. Posted numbers always come from the facts,
// never from the model's text.

function extractJson(raw) {
  const s = String(raw == null ? '' : raw);
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('Agent did not return a JSON object');
  return JSON.parse(s.slice(start, end + 1));
}

const isIntArray = (a) => Array.isArray(a) && a.every((n) => Number.isInteger(n));

function reconcile(agent, facts) {
  const problems = [];
  if (!agent || typeof agent !== 'object') return { ok: false, problems: ['Agent output is not an object'] };

  if (agent.open_deals_count !== facts.open_count) {
    problems.push(`open_deals_count: agent said ${agent.open_deals_count}, Pipedrive data says ${facts.open_count}`);
  }
  if (agent.stale_deals_count !== facts.stale_count) {
    problems.push(`stale_deals_count: agent said ${agent.stale_deals_count}, Pipedrive data says ${facts.stale_count}`);
  }
  if (!isIntArray(agent.stale_deal_ids)) {
    problems.push('stale_deal_ids is missing or not a list of integers');
  } else {
    const a = [...agent.stale_deal_ids].sort((x, y) => x - y).join(',');
    const f = [...facts.stale_ids].sort((x, y) => x - y).join(',');
    if (a !== f) problems.push(`stale_deal_ids differ: agent [${a}] vs data [${f}]`);
  }
  const openSet = new Set(facts.open_ids);
  for (const fu of Array.isArray(agent.follow_ups) ? agent.follow_ups : []) {
    if (!fu || !openSet.has(fu.deal_id)) problems.push(`follow_up references deal ${fu && fu.deal_id}, which is not an open deal`);
  }
  if (typeof agent.headline !== 'string' || !agent.headline.trim()) problems.push('headline is missing');
  return { ok: problems.length === 0, problems };
}

// The agent's text is influenced by CRM content someone else wrote. Never let it ping a channel or inject Slack links.
function sanitizeForSlack(s, maxLen) {
  return String(s == null ? '' : s)
    .replace(/<[^>]*>/g, ' ')          // drops HTML tags AND Slack syntax such as <!channel>, <@U123>, <http://x|label>
    .replace(/[<>]/g, '')               // any stray brackets
    .replace(/@(channel|here|everyone)\b/gi, '$1')
    .replace(/\s+/g, ' ').trim()
    .slice(0, maxLen);
}

function money(n) {
  const [whole, frac] = Number(n).toFixed(2).split('.');
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + frac;
}

function buildDigestText(agent, facts, whenLabel) {
  const values = Object.entries(facts.value_by_currency).map(([cur, v]) => `${cur} ${money(v)}`).join(', ') || 'n/a';
  const lines = [];
  lines.push(`*Daily ops digest* (${whenLabel})`);
  lines.push(sanitizeForSlack(agent.headline, 200));
  lines.push(`Open deals: *${facts.open_count}* (${values}) | Stale (no next step, idle ${facts.stale_days}+ days): *${facts.stale_count}*`);
  if (facts.stale.length) {
    lines.push('*Stale deals*');
    for (const d of facts.stale.slice(0, 10)) {
      lines.push(`- #${d.id} ${sanitizeForSlack(facts.titles[d.id], 90)} (idle ${d.days_idle}d)`);
    }
    if (facts.stale.length > 10) lines.push(`...and ${facts.stale.length - 10} more`);
  }
  const followUps = (Array.isArray(agent.follow_ups) ? agent.follow_ups : []).slice(0, 5);
  if (followUps.length) {
    lines.push('*Suggested follow-ups*');
    for (const fu of followUps) lines.push(`- #${fu.deal_id} ${sanitizeForSlack(facts.titles[fu.deal_id], 60)}: ${sanitizeForSlack(fu.action, 160)}`);
  }
  lines.push('_Counts verified against Pipedrive data before posting._');
  return lines.join('\n');
}

if (typeof module !== 'undefined' && module.exports) module.exports = { extractJson, reconcile, sanitizeForSlack, buildDigestText, money };
