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
4. **[2026-03-17] Astrea can invalidate the browser session mid-sequence**
   Do instead: treat `API_ERROR_401` and `INVALID_SESSION_EXCEPTION` as session-recovery signals, invalidate the shared session, and force re-authentication before retrying.

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
4. **[2026-03-17] Atendimentos do Astrea usam `consulting/query`, não `/consulting/all`**
   Do instead: listar com `POST /consulting/query` + `POST /consulting/query/count`, e criar com `POST /consulting` incluindo `messages[]` além de `message`.
5. **[2026-06-22] Login robusto — estruturado, com breaker e sessão persistida**
   Do instead: erros de login chegam como `LOGIN_FAILED_<STATE>` (login-state.ts) ou `LOGIN_CIRCUIT_OPEN` (breaker, 3 falhas → cooldown 60s), não-retentados pelo `retryIf` (corta amplificação K×3) e mapeados a 503+Retry-After. A sessão é persistida em `storageState` (`session-state.ts`, honra `SESSION_REUSE`): cold-start restaura em vez de re-logar; `clearCookies` só em `forceClear` (pós-invalidação). Heurística pós-login/breaker/sessão são puras/testáveis — Playwright fica só no glue de `pool.ts`. Observabilidade em `GET /health` bloco `login`.

## Agenda (compromissos) — aprendizados de 25/09/2026
1. **[2026-09-25] Busca de contatos do Astrea (/contact/all, queryDTO.text) NÃO acha por telefone**
   Do instead: achar pelo nome e confirmar com `telefonesIguais`; nunca contar com busca por dígitos.
2. **[2026-09-25] Edição de .ts com regex via heredoc do Bash perde as barras invertidas (\\d vira d)**
   Do instead: escrever scripts de edição em arquivo (Write) e rodar com node; conferir com grep após editar.
3. **[2026-09-25] Teste ao vivo sem sujar produção: rodar a api local (PORT=3999, BROWSER_POOL_SIZE=2) e criar só na agenda do usuário de automação (6528036269752320), apagando tudo ao final**
   CUIDADO (item 4): o login local DERRUBA a sessão da produção — só fora do expediente.
4. **[2026-09-25] O Astrea mantém UMA sessão por usuário: qualquer login da conta de automação (api local, script, alguém no navegador) derruba a sessão da api em produção**
   Do instead: nunca rodar api/scripts locais com a conta de produção em horário de uso; se precisar, avisar e rodar fora do expediente. Todo sinal de "sessão morta" (401, sem userId no localStorage) tem de passar por `isSessionRecoveryError` — AUTH_FAILED não invalida a sessão (incidente de 25/09: api presa até o redeploy). O teto de logins fica no pool (`relogin-budget.ts`), não em cada gatilho.
   Do instead: registrar ids criados/apagados em docs/agenda-eventos-discovery.md; no Windows, parar o node pela porta (TaskStop não mata o filho).

## User Directives
1. **[2026-03-12] Keep collaboration concise and action-oriented**
   Do instead: send short progress updates, make reasonable assumptions, and execute the task end-to-end when safe.
