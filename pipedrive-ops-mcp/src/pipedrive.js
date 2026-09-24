// Small Pipedrive client. Uses API v2 for deals/activities (v1 for those is out of support since 1 Aug 2026).
// Notes have no v2 endpoint yet, so they stay on /v1/notes, which is not on the deprecation list.
//
// Reliability rules:
//  - hard timeout on every request
//  - retries ONLY for GET (429 / 5xx / network); POST is never retried, so a retry can never double-write
//  - the API token travels in a header and is never included in URLs, logs or error messages
//  - cursor pagination has a repeat-cursor guard and a page cap, so it cannot loop forever

class PipedriveError extends Error {
  constructor(message, { status, retryable = false } = {}) {
    super(message);
    this.name = 'PipedriveError';
    this.status = status;
    this.retryable = retryable;
  }
}

const DEAL_EXTRA_FIELDS = 'next_activity_id,undone_activities_count';

function createPipedriveClient({
  baseUrl = 'https://api.pipedrive.com',
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
  maxRetries = 2,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  if (!token) throw new Error('Pipedrive token is required');
  const backoff = (attempt) => Math.min(250 * 2 ** (attempt - 1), 2000);

  async function request(method, path, { query, body } = {}) {
    const url = new URL(path, baseUrl);
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const canRetry = method === 'GET';
    let attempt = 0;

    for (;;) {
      attempt += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let res;
        try {
          res = await fetchImpl(url, {
            method,
            headers: { 'x-api-token': token, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal,
          });
        } catch (err) {
          if (canRetry && attempt <= maxRetries) { await sleep(backoff(attempt)); continue; }
          const timedOut = err && err.name === 'AbortError';
          throw new PipedriveError(timedOut ? `Pipedrive request timed out after ${timeoutMs}ms` : 'Pipedrive request failed (network error)', { retryable: true });
        }

        if (res.ok) {
          try { return await res.json(); } catch { throw new PipedriveError('Pipedrive returned a response that was not valid JSON'); }
        }

        if (canRetry && (res.status === 429 || res.status >= 500) && attempt <= maxRetries) {
          const retryAfter = Number(res.headers.get('retry-after'));
          await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 5000) : backoff(attempt));
          continue;
        }

        let detail = '';
        try { const j = await res.json(); detail = String(j.error || j.message || '').slice(0, 200); } catch { /* ignore */ }
        throw new PipedriveError(`Pipedrive ${method} ${url.pathname} failed with HTTP ${res.status}${detail ? ': ' + detail : ''}`, { status: res.status, retryable: res.status === 429 || res.status >= 500 });
      } finally {
        clearTimeout(timer);
      }
    }
  }

  async function listOpenDeals({ maxDeals = 2000, pageSize = 500 } = {}) {
    const deals = [];
    const seen = new Set();
    let cursor;
    for (let page = 0; page < 20; page += 1) {
      const r = await request('GET', '/api/v2/deals', {
        query: { status: 'open', limit: pageSize, cursor, include_fields: DEAL_EXTRA_FIELDS, sort_by: 'id', sort_direction: 'asc' },
      });
      deals.push(...(Array.isArray(r.data) ? r.data : []));
      const next = r.additional_data && r.additional_data.next_cursor;
      if (!next) return { deals, truncated: false };
      if (seen.has(next)) throw new PipedriveError('Pagination cursor repeated; aborting to avoid an infinite loop');
      seen.add(next);
      cursor = next;
      if (deals.length >= maxDeals) break;
    }
    return { deals: deals.slice(0, maxDeals), truncated: true };
  }

  async function getDeal(id) {
    const r = await request('GET', `/api/v2/deals/${encodeURIComponent(id)}`, { query: { include_fields: DEAL_EXTRA_FIELDS } });
    return r.data;
  }

  async function listOpenActivities(dealId, limit = 25) {
    const r = await request('GET', '/api/v2/activities', { query: { deal_id: dealId, done: false, limit, sort_by: 'due_date', sort_direction: 'asc' } });
    return Array.isArray(r.data) ? r.data : [];
  }

  async function listNotes(dealId, limit = 3) {
    const r = await request('GET', '/v1/notes', { query: { deal_id: dealId, limit, sort: 'add_time DESC' } });
    return Array.isArray(r.data) ? r.data : [];
  }

  async function addNote(dealId, content) {
    const r = await request('POST', '/v1/notes', { body: { content, deal_id: dealId } });
    return r.data;
  }

  return { request, listOpenDeals, getDeal, listOpenActivities, listNotes, addNote };
}

module.exports = { createPipedriveClient, PipedriveError };
