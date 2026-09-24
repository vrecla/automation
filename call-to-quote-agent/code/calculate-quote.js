// NODE: "Calculate Quote"
// Purpose: deterministic pricing. The LLM NEVER sees or produces a price.
// All money is integer cents (no floating-point drift). Rates below are DEMO placeholders (AUD, ex GST).

const RATES_CENTS = {
  lifted_slab: { low: 9000, medium: 15000, high: 24000 },
  crack:       { low: 6000, medium: 9500,  high: 15000 },
  gap:         { low: 5500, medium: 9000,  high: 14000 },
  spalling:    { low: 7000, medium: 12000, high: 19000 },
  other:       { low: 10000, medium: 16000, high: 25000 },
};
const CALLOUT_CENTS = 18000;
const MIN_CHARGE_CENTS = 35000;   // minimum job charge, ex GST
const URGENT_PCT = 15;            // surcharge on hazard work (not call-out)
const GST_PCT = 10;
const HIGH_VALUE_CENTS = 1500000; // >= $15,000 inc GST gets flagged in the approval message
const HARD_CAP_CENTS = 5000000;   // > $50,000 inc GST is almost certainly a bad extraction: fail loudly

function money(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function calculateQuote(data) {
  const lines = [];
  const flags = [];
  let itemsCents = 0;

  for (const h of data.hazards) {
    const unit = (RATES_CENTS[h.type] || {})[h.severity];
    if (!Number.isInteger(unit)) throw new Error(`No rate for ${h.type}/${h.severity}`);
    const total = unit * h.quantity;
    itemsCents += total;
    lines.push({
      location: h.location || 'Unspecified location',
      type: h.type, severity: h.severity, quantity: h.quantity,
      unit_cents: unit, total_cents: total,
    });
    if (h.type === 'other') flags.push('manual_price_check: "other" hazard priced at default rate');
  }

  const urgentCents = data.urgency === 'urgent' ? Math.round((itemsCents * URGENT_PCT) / 100) : 0;
  let exGstCents = CALLOUT_CENTS + itemsCents + urgentCents;
  let minAdjustCents = 0;
  if (exGstCents < MIN_CHARGE_CENTS) {
    minAdjustCents = MIN_CHARGE_CENTS - exGstCents;
    exGstCents = MIN_CHARGE_CENTS;
  }
  const gstCents = Math.round((exGstCents * GST_PCT) / 100);
  const totalCents = exGstCents + gstCents;

  if (totalCents > HARD_CAP_CENTS) {
    throw new Error(`Quote total ${money(totalCents)} exceeds sanity cap ${money(HARD_CAP_CENTS)}; check the extraction`);
  }
  if (totalCents >= HIGH_VALUE_CENTS) flags.push('high_value');
  if (data.urgency === 'urgent') flags.push('urgent');

  return {
    lines, flags: [...new Set(flags)],
    callout_cents: CALLOUT_CENTS, items_cents: itemsCents, urgent_cents: urgentCents,
    min_adjust_cents: minAdjustCents, ex_gst_cents: exGstCents, gst_cents: gstCents, total_cents: totalCents,
  };
}

function buildQuoteText(callId, data, q) {
  const out = [];
  out.push(`*Draft quote* for ${data.address_line}, ${data.suburb} ${data.state} ${data.postcode || ''}`.trim());
  out.push(`Call: ${callId} | Contact: ${data.caller_name || 'unknown'}${data.caller_company ? ' (' + data.caller_company + ')' : ''} | ${data.caller_phone || data.caller_email}`);
  out.push(`Urgency: ${data.urgency}`);
  for (const l of q.lines) out.push(`- ${l.quantity} x ${l.type} (${l.severity}), ${l.location}: ${money(l.total_cents)}`);
  out.push(`Call-out: ${money(q.callout_cents)}`);
  if (q.urgent_cents) out.push(`Urgent surcharge (${URGENT_PCT}%): ${money(q.urgent_cents)}`);
  if (q.min_adjust_cents) out.push(`Minimum charge adjustment: ${money(q.min_adjust_cents)}`);
  out.push(`Ex GST: ${money(q.ex_gst_cents)} | GST: ${money(q.gst_cents)} | *Total: ${money(q.total_cents)}*`);
  if (q.flags.length) out.push(`Flags: ${q.flags.join(', ')}`);
  return out.join('\n');
}

function buildQuoteHtml(callId, data, q) {
  const rows = q.lines.map((l) =>
    `<li>${l.quantity} x ${escapeHtml(l.type)} (${escapeHtml(l.severity)}) - ${escapeHtml(l.location)}: ${money(l.total_cents)}</li>`).join('');
  return [
    `<b>DRAFT QUOTE - awaiting approval</b> (call ${escapeHtml(callId)})<br>`,
    `Site: ${escapeHtml(data.address_line)}, ${escapeHtml(data.suburb)} ${escapeHtml(data.state)} ${escapeHtml(data.postcode || '')}<br>`,
    `Urgency: ${escapeHtml(data.urgency)}<br>`,
    `<ul>${rows}</ul>`,
    `Call-out: ${money(q.callout_cents)}<br>`,
    q.urgent_cents ? `Urgent surcharge: ${money(q.urgent_cents)}<br>` : '',
    q.min_adjust_cents ? `Minimum charge adjustment: ${money(q.min_adjust_cents)}<br>` : '',
    `Ex GST: ${money(q.ex_gst_cents)} | GST: ${money(q.gst_cents)} | <b>Total: ${money(q.total_cents)}</b><br>`,
    data.notes ? `Notes from call: ${escapeHtml(data.notes)}<br>` : '',
    q.flags.length ? `Flags: ${escapeHtml(q.flags.join(', '))}<br>` : '',
  ].join('');
}

function buildDealTitle(callId, data) {
  return `Footpath repairs - ${data.address_line}, ${data.suburb} [${callId}]`;
}

function buildOrgName(data) {
  return data.caller_company || `${data.address_line}, ${data.suburb}`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { calculateQuote, buildQuoteText, buildQuoteHtml, buildDealTitle, buildOrgName, money, RATES_CENTS };
}

if (typeof $input !== 'undefined') {
  const input = $input.first().json;
  const quote = calculateQuote(input.data);
  return [{
    json: {
      ...input,
      quote,
      quote_text: buildQuoteText(input.call_id, input.data, quote),
      quote_html: buildQuoteHtml(input.call_id, input.data, quote),
      deal_title: buildDealTitle(input.call_id, input.data),
      org_name: buildOrgName(input.data),
    },
  }];
}
