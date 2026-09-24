# Automation Projects

Two projects built around n8n, Claude and Pipedrive. Each folder has its own README with setup steps, safety design, tests and an honest account of what has and hasn't been verified.

| Project | What it is | Stack |
|---|---|---|
| [`call-to-quote-agent/`](./call-to-quote-agent) | Turns a call transcript into a draft quote in Pipedrive, with validation, duplicate detection and a human approval step before anything is marked ready to send | n8n, JavaScript, Claude API, Pipedrive API v2, Slack |
| [`pipedrive-ops-mcp/`](./pipedrive-ops-mcp) | A Node.js MCP server (read-only tools plus a locked write tool) and an n8n agent that writes a daily deals digest, verified by code before it is posted | Node.js, MCP, n8n, Claude, Pipedrive API v2, Render |

## What both projects demonstrate

- **Safe to run unattended:** input validation, duplicate detection, human approval, error alerts, and never trusting model output without checking it.
- **AI kept in its lane:** the model extracts and summarises; pricing and the numbers that get posted are computed by tested code.
- **Tested before shipping:** 53 and 55 automated tests, plus live runs against real Pipedrive, Claude and Slack accounts.
- **Maintainable:** code lives in real files, workflow JSON is generated from it, and each project has a `CLAUDE.md` so it can be changed with Claude Code.

## Repository layout

```
call-to-quote-agent/
pipedrive-ops-mcp/
```

Deploying `pipedrive-ops-mcp` to Render from this repo: set the service's **Root Directory** to `pipedrive-ops-mcp`.

Built by Vanessa Recla.
