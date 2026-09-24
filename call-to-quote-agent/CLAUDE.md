# CLAUDE.md: Call-to-Quote Agent

n8n workflow: call transcript -> Claude extraction -> validation -> deterministic quote -> Pipedrive -> Slack approval.

## Layout
- `code/*.js`: source of truth for every n8n Code node (one file per node). Each file has a pure function (exported for tests) plus a small guarded n8n glue block at the bottom.
- `scripts/build-workflow.js`: builds `workflows/*.json` from `code/`. **Never hand-edit the workflow JSON.**
- `workflows/`: generated, importable n8n JSON (main workflow and error workflow).
- `tests/`: `node --test`. `pipeline.test.js` runs the real embedded code against a fake n8n runtime.
- `sample-transcripts/`: input payloads. `scripts/send-sample.js` posts one to the webhook.

## Commands
- `npm test`: run all tests (no network)
- `npm run build`: regenerate workflows after editing `code/`
- Order of work: edit `code/` -> add/adjust a test -> `npm run build` -> `npm test` -> re-import in n8n

## Rules (do not break these)
1. **The LLM never produces or sees prices.** All money is integer cents in `calculate-quote.js`.
2. **Validate before writing to the CRM.** Nothing goes to Pipedrive unless `Validate Extraction` passes.
3. **Do not add retries to POST nodes that create records** (duplicates). Retries are only for GET searches and the Claude call. `workflow.test.js` enforces this.
4. **Anything that is not an explicit "approve" means not approved.**
5. Keep `HAZARD_TYPES`/`SEVERITIES` in `validate-extraction.js` in sync with the tool schema in `build-claude-request.js` and the rate table in `calculate-quote.js`.
6. Change a rate or the service area? Update the constants at the top of the relevant file and the hand-calculated expectations in `tests/calculate-quote.test.js`.
7. Caller-controlled text (notes, locations) must be HTML-escaped before going into Pipedrive notes.

## Things to check when something breaks
- Error alert in Slack shows the node name and execution link. Open that execution in n8n and read the node's input/output.
- Review-queue messages list exactly which validation rule failed.
