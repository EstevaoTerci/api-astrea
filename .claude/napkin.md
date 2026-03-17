# Napkin Runbook

## Curation Rules
- Re-prioritize on every read.
- Keep recurring, high-value notes only.
- Max 10 items per category.
- Each item includes date + "Do instead".

## Execution & Validation (Highest Priority)
1. **[2026-03-12] Validate only what the task needs**
   Do instead: run the smallest useful check after changes or automation steps and report any limits clearly.
2. **[2026-03-16] Local smoke runs fail if browser pool exceeds validator cap**
   Do instead: override `BROWSER_POOL_SIZE=3` when starting the API or MCP locally if the `.env` value is higher.
3. **[2026-03-16] ESLint 9 is not wired yet in this repo**
   Do instead: expect `npm run lint` to fail until an `eslint.config.*` file exists, and rely on `npm run build` plus focused smoke tests meanwhile.

## Shell & Command Reliability
1. **[2026-03-12] Prefer fast repo search tools**
   Do instead: use `rg`/`rg --files` first for discovery before slower PowerShell alternatives.

## Domain Behavior Guardrails
1. **[2026-03-13] Keep domain models under `src/models`**
   Do instead: define entity contracts in `src/models` and reserve `src/types` for filters, API envelopes, and shared service types.
2. **[2026-03-13] Coolify stacks should not rely on `env_file` detection**
   Do instead: declare runtime variables explicitly in `docker-compose.yml`, avoid `container_name`, and enable `trust proxy` behind Coolify's reverse proxy.
3. **[2026-03-14] Manual Trigger workflows are awkward to validate remotely**
   Do instead: use `Manual Trigger` only for ad hoc UI runs; switch smoke tests to `Webhook` when they need remote execution from MCP or external tooling.

## User Directives
1. **[2026-03-12] Keep collaboration concise and action-oriented**
   Do instead: send short progress updates, make reasonable assumptions, and execute the task end-to-end when safe.
