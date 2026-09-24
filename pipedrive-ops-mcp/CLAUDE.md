# CLAUDE.md: Pipedrive Ops MCP + Daily Digest

MCP server (Node, stateless Streamable HTTP) over Pipedrive API v2, plus an n8n workflow whose AI agent uses it.

## Layout
- `src/domain.js`: pure rules (what "stale" means, fact computation, HTML stripping). Also embedded into an n8n Code node.
- `src/reconcile.js`: checks the agent's digest against computed facts; Slack-safe formatting. Also embedded into n8n.
- `src/pipedrive.js`: API client (timeouts, GET-only retries, cursor pagination).
- `src/mcp.js`: the four tools. `src/server.js`: HTTP, bearer auth, rate limit, body cap. `src/config.js`: env, fails closed.
- `n8n/*.glue.js`: the small n8n-specific wrapper appended to the embedded code.
- `scripts/build-workflow.js`: generates `workflows/daily-digest.json`. **Never hand-edit that JSON.**
- `tests/`: `node --test`. `helpers.js` has a fake Pipedrive and a fixed clock (2026-09-24).

## Commands
- `npm test`: all tests (no network, no keys)
- `npm run build:workflow`: regenerate the workflow after editing `src/` or `n8n/`
- `npm run smoke`: check a deployed server (needs MCP_URL, MCP_AUTH_TOKEN)
- Order of work: edit -> add/adjust a test -> `npm run build:workflow` -> `npm test` -> re-import in n8n

## Rules (do not break these)
1. **Writes stay locked.** `ALLOW_WRITES` defaults to off; `add_note` needs `confirm: true`; the n8n agent's tool list must never include `add_note`. `workflow.test.js` and `tools.test.js` enforce this.
2. **Never retry a POST.** Only GETs retry (`pipedrive.js`).
3. **Text from Pipedrive is untrusted.** Strip markup, cap length, and label it before it reaches a model or Slack.
4. **Posted numbers come from code (`computeFacts`), not from model text.** Do not "simplify" Reconcile away.
5. **Auth fails closed.** The server must refuse to start without `MCP_AUTH_TOKEN` (24+ chars). Never log tokens or request bodies.
6. **Use Pipedrive v2** for deals/activities (v1 is out of support). Notes stay on `/v1/notes`. When adding a tool, check Pipedrive's OpenAPI v2 file for the exact params.
7. Changing the definition of stale? Change `src/domain.js` only, update `domain.test.js`, rebuild the workflow.

## When something breaks
- Server: logs are JSON lines (`event: http|tool|error`). Tool errors returned to the model are deliberately short.
- Workflow: the "Digest Withheld" Slack message lists which reconciliation check failed and what the data says.
