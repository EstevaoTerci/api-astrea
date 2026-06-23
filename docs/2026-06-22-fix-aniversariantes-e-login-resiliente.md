# Sessão 2026-06-22 — Fix `listar_aniversariantes` (REST estável) + Login resiliente

Registro da sessão. Duas frentes entregues, ambas validadas em produção e deployadas
(PR [#1](https://github.com/EstevaoTerci/api-astrea/pull/1), deploy Coolify #787,
commit de merge `c93bb45`).

---

## Frente 1 — `listar_aniversariantes` voltou a funcionar

### Sintoma

A tool MCP `listar_aniversariantes` falhava **100% em produção** com
`Erro: page.evaluate: Error: API_ERROR_-1`. Uma colaboradora pediu os aniversariantes
de julho e recebeu "nenhum encontrado" (falso). O `/health` confirmava: o cache de
aniversariantes nunca populava (`misses` subindo, `entries: 0`).

### Causa-raiz

A implementação usava o trio `POST /contact/all/count` → `POST /contact/prepare-list-report`
→ **`GET /report/contactdetail`**. Esse último é um endpoint **interno** do Astrea (fora
de `/api/v2`, alimenta a tela "Ficha completa") e passou a retornar **status `-1`** —
request abortada/sem resposta no transporte (provável CORS/redirect cross-origin nesse
host). Os logs do Coolify mostravam 13× `Erro em listarAniversariantesEnriquecidos`
vindo de `astreaAppGet`, enquanto `/api/v2/contact/all` e `/contact/{id}/details`
respondiam normalmente. Era a quebra silenciosa de um endpoint não-documentado, já
sinalizada como risco.

### Fix

Migração para os endpoints REST **estáveis** (os mesmos de `listar_clientes` /
`buscar_cliente`):

1. `POST /contact/all` com `queryDTO.birthMonth` (filtro server-side) + `paging` grande
   → a lista do mês inteiro em uma chamada.
2. `GET /contact/{id}/details` por contato, com **concorrência limitada (6) numa única
   aba** → enriquece com `birthDate` + `taxDocumentNumber`, que a lista não traz.

- **Contrato preservado**: `Cliente[]` enriquecido, `dataNascimento` em **ISO**
  (`normalizeBirthToIso` converte o `dd/MM/yyyy` que o `/details` devolve), `cpfCnpj`,
  telefone, endereço, etc. Zero mudança para o consumer (`assistente-claude-escritorio`).
- **Sem risco de ban**: o enriquecimento N+1 roda numa só aba (não abre abas paralelas).
  Mitigado pelo cache de 60s.
- Removido o trio do report e seus mappers. O endpoint `/report/contactdetail` fica
  documentado como **descontinuado** — não voltar sem re-discovery confirmando que o `-1`
  sumiu.

### Verificação em prod

`GET /api/clientes/aniversariantes?mes=7` → **107 contatos** enriquecidos
(ex.: `Adriana Florentina Mendes | nasc=1974-07-04 | cpf=042.328.197-62`).

---

## Frente 2 — Login do pool resiliente (P0 + P1 + P2)

### Sintoma

`page.waitForFunction: Timeout 30000ms exceeded` em `BrowserPool._doLogin`, **intermitente
e espalhado** por várias tools (`listarUsuarios`, `listarClientes`, `listarTarefas`…) —
o login compartilhado falhando ao re-logar. Login funcionava às vezes, então flakiness,
não credencial errada.

### Causas-raiz (investigação multi-agente + logs Coolify)

1. **Cold-login pós idle-shutdown bate no teto de 30s** — `BROWSER_IDLE_TTL_MS=15min`
   destrói o browser; o próximo request paga launch+UI-login. ~83% dos timeouts eram o
   1º login após "Iniciando browser Chromium". Login saudável: mediana ~12s, cauda ~27s.
2. **Amplificação K×3** — 1 login que estoura derrubava N requests E o `withRetry`
   reclassificava o Timeout como retryable, refazendo `_doLogin`+`clearCookies` → tempestade
   de logins (padrão que a Astrea trata como uso indevido).
3. **`clearCookies` incondicional** + **`SESSION_REUSE` flag morto** (definido, nunca lido).
4. **Diagnóstico cego** — o timeout virava erro cru sem url/hash/estado.

### Fix (faseado)

**P0 — diagnóstico + corte da amplificação** (sem persistir nada):
- [`src/browser/login-state.ts`](../src/browser/login-state.ts) (puro): `classifyPostLoginState`
  (AUTHENTICATED / CREDENTIAL_FAILED / STILL_ON_LOGIN / INTERSTITIAL / UNKNOWN), erro
  estruturado `LOGIN_FAILED_<STATE>`, `isLoginError`, `shouldRetryLogin`, `isBrowserUnavailableError`.
- [`src/browser/login-breaker.ts`](../src/browser/login-breaker.ts) (puro): `LoginCircuitBreaker`
  (3 falhas → cooldown 60s → `LOGIN_CIRCUIT_OPEN`), clock injetado.
- `pool._doLogin`: `Promise.race` sucesso-vs-banner em vez do `waitForFunction` cego;
  snapshot + erro estruturado no catch; **timeout de login dedicado de 45s**
  (`BROWSER_LOGIN_TIMEOUT_MS`) cobrindo a cauda do cold-start.
- `astrea-http` `retryIf`: falha de login **não é re-tentada** (corta a amplificação K×3).

**P1 — persistência de sessão** (ataca a causa-raiz #1):
- [`src/browser/session-state.ts`](../src/browser/session-state.ts) (puro, fs/clock
  injetáveis): `storageState` durável atômico (tmp+rename), `isStateUsable` (idade < 6h +
  material de credencial), `redactSession`.
- `pool`: **restauro otimista** no `_initialize` (cria o context com a sessão e marca
  autenticado, pulando o UI-login; se a sessão tiver morrido, o recovery de 401 re-loga
  limpo); persiste após login e antes do shutdown; `clearCookies` só em `forceClear`
  (pós-invalidação). **`SESSION_REUSE` finalmente honrado.**

**P2 — observabilidade + back-pressure**:
- `GET /health` ganhou bloco `login`: `breaker` (state/consecutiveFailures/openUntil),
  `session` (reuseEnabled/restoredFromStorage/ageMs), `counters` (coldStarts/logins/loginFailures),
  `lastFailure`.
- `LOGIN_CIRCUIT_OPEN` → **503 + `Retry-After: 60`**; `LOGIN_FAILED_*` → **503 + `Retry-After: 15`**.

### Discovery que validou o P1 end-to-end

[`scripts/dump-storage-state.mjs`](../scripts/dump-storage-state.mjs): faz 1 login headless,
dá dump do `storageState` (forma redigida, segredos apagados), e testa o **restauro** num
segundo context. Resultado: restaurar a sessão pula o login E o probe REST
`POST /contact/all/count` retorna **HTTP 200** (count=2394). Confirma que o token sobrevive
no `storageState` (cookies) e que o restauro autentica a API. Login headless funciona (sem
captcha). `isStateUsable` mantido conservador (gate por idade + rede de 401-recovery), sem
fixar nome de cookie de auth (frágil).

### Verificação em prod (pós-deploy)

`GET /health` → bloco `login` presente; após a 1ª operação: `breaker: CLOSED`,
`counters: { coldStarts: 1, logins: 1, loginFailures: 0 }`, `session.ageMs: ~50s`
(o `storageState` foi gravado). No próximo cold-start, `restoredFromStorage` deve virar
`true` e `logins` não incrementar — é o P1 evitando o re-login.

---

## Novas variáveis de ambiente

| Var | Default | Para quê |
| --- | --- | --- |
| `BROWSER_LOGIN_TIMEOUT_MS` | `45000` | timeout dedicado da espera pós-login (cobre a cauda do cold-start sem afrouxar operações) |
| `LOGIN_BREAKER_THRESHOLD` | `3` | falhas consecutivas que abrem o circuit breaker de login |
| `LOGIN_BREAKER_COOLDOWN_MS` | `60000` | tempo que o breaker segura novos logins |
| `SESSION_REUSE` | `true` | liga a persistência/restauro do `storageState` (antes era flag morto) |
| `SESSION_STATE_PATH` | tmpdir/`astrea-session.json` | onde o `storageState` é gravado |
| `SESSION_STATE_MAX_AGE_MS` | `21600000` (6h) | idade máxima da sessão persistida antes de exigir re-login |

---

## Testes e qualidade

- **209 testes verdes** (`npm test`), `tsc`/build limpos.
- Módulos puros novos: `login-state` 100%, `login-breaker` 100%, `session-state` 92%.
- Regra do projeto respeitada: **Playwright nunca roda em teste** — toda a lógica de
  decisão é pura/testável; o Playwright fica só no glue de `pool.ts`.

## O que acompanhar nos próximos dias

- Counters do bloco `login` do `/health`: a taxa real de `restoredFromStorage` vs novos
  `logins` revela o ganho do P1 e permite afinar `SESSION_STATE_MAX_AGE_MS` (o TTL real da
  sessão server-side do Astrea não foi medido; 6h é piso seguro).
- Se aparecer `LOGIN_FAILED_INTERSTITIAL` nos logs/`lastFailure`, é sinal de captcha/2FA/
  sessão-concorrente real — aí vale um discovery `headless:false` para mapear o seletor.
