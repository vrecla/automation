// Pure business rules. No network, no MCP. This file is ALSO embedded (by scripts/build-workflow.js) into an
// n8n Code node, so the digest workflow and the MCP server apply exactly the same definition of "stale".
//
// DEFINITION: a deal is STALE when it is open, has no scheduled next step (no undone activity), and nothing
// has touched it (update, stage change, or creation) for at least N days.
// Caveat: Pipedrive's `update_time` may not move when a note or email is added, so treat "stale" as
// "worth a look", not proof of neglect.

const DAY_MS = 24 * 60 * 60 * 1000;

function parseTime(value) {
  if (!value) return null;
  let s = String(value);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) s = s.replace(' ', 'T') + 'Z'; // v1-style timestamps are UTC
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

function lastTouchedMs(deal) {
  const times = [deal.update_time, deal.stage_change_time, deal.add_time].map(parseTime).filter((t) => t !== null);
  return times.length ? Math.max(...times) : null;
}

function daysIdle(deal, nowMs) {
  const t = lastTouchedMs(deal);
  if (t === null) return null; // unknown: never guess
  return Math.max(0, Math.floor((nowMs - t) / DAY_MS));
}

function hasScheduledNext(deal) {
  return Number(deal.undone_activities_count) > 0 || (deal.next_activity_id !== null && deal.next_activity_id !== undefined);
}

function isStale(deal, nowMs, days) {
  if (deal.status !== 'open') return false;
  if (hasScheduledNext(deal)) return false;
  const idle = daysIdle(deal, nowMs);
  return idle !== null && idle >= days;
}

function compactDeal(deal, nowMs) {
  return {
    id: deal.id,
    title: deal.title,
    value: deal.value,
    currency: deal.currency,
    stage_id: deal.stage_id,
    owner_id: deal.owner_id,
    days_idle: daysIdle(deal, nowMs),
    has_next_activity: hasScheduledNext(deal),
  };
}

const round2 = (n) => Math.round(n * 100) / 100;

// Single source of truth for the numbers in a digest. Used by the MCP tools AND the n8n reconciliation step.
function computeFacts(deals, nowMs, staleDays) {
  const open = deals.filter((d) => d.status === 'open');
  const staleDeals = open
    .filter((d) => isStale(d, nowMs, staleDays))
    .map((d) => compactDeal(d, nowMs))
    .sort((a, b) => b.days_idle - a.days_idle || a.id - b.id);
  const valueByCurrency = {};
  for (const d of open) {
    const cur = d.currency || 'UNKNOWN';
    valueByCurrency[cur] = round2((valueByCurrency[cur] || 0) + (Number(d.value) || 0));
  }
  const titles = {};
  for (const d of open) titles[d.id] = d.title;
  return {
    stale_days: staleDays,
    open_count: open.length,
    open_ids: open.map((d) => d.id).sort((a, b) => a - b),
    value_by_currency: valueByCurrency,
    stale_count: staleDeals.length,
    stale_ids: staleDeals.map((d) => d.id).sort((a, b) => a - b),
    stale: staleDeals,
    titles,
  };
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Notes come from outside (callers, colleagues, other automations). Strip markup and cap length before an LLM sees them.
function stripHtml(s, maxLen = 300) {
  const text = String(s == null ? '' : s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
  return text.length > maxLen ? text.slice(0, maxLen - 1) + '…' : text;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DAY_MS, parseTime, lastTouchedMs, daysIdle, hasScheduledNext, isStale, compactDeal, computeFacts, escapeHtml, stripHtml };
}
