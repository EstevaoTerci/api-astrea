# CLAUDE.md

## Consumidor principal

Esta API é consumida quase que exclusivamente pelo projeto [`assistente-claude-escritorio`](C:\Users\evert\Desktop\Projetos\assistente-claude-escritorio) (repositório <https://github.com/EstevaoTerci/assistente-claude-escritorio>).

Mudanças de contrato (rotas, payloads, headers, códigos de erro) devem considerar o impacto nesse consumidor antes de serem aplicadas. Quando houver dúvida sobre um endpoint estar em uso, verifique o código do `assistente-claude-escritorio` antes de remover ou alterar comportamento.

## Limites operacionais

### `BROWSER_POOL_SIZE` — teto 5

A schema do env ([src/config/env.ts](src/config/env.ts)) força `max(5)` propositalmente. Não subir além disso, mesmo sob pressão de fila:

- Cada Chromium extra custa ~250 MB RAM (3 → 5 ≈ +500 MB; cabe na VPS de 23 GB).
- **Mais importante**: a Astrea (servidor externo) tem detecção de uso indevido por conta. Múltiplas abas paralelas na mesma sessão logada elevam o risco da conta do escritório ser bloqueada. 5 é onde marginal benefit cai.

Se a fila estiver acumulando consistentemente com pool=5, a resposta não é "subir pool" — é deduplicar/cachear no service ou empurrar back-pressure pro consumer (429 + Retry-After).

### Cache + rate limit

- `listarClientes` tem cache server-side com TTL 60s + inflight dedup ([src/utils/cache.ts](src/utils/cache.ts), `InflightTtlCache`). Só cobre filtros estruturais (mesAniversario, estado, etiquetas); buscas livres (nome/cpfCnpj/email) pulam cache por cardinalidade alta.
- Rate limit é por IP, default 50 req/60s ([src/middleware/rate-limiter.ts](src/middleware/rate-limiter.ts)). Excedente recebe 429 com `Retry-After`. Cobre defesa contra retry-storm de consumer mal-comportado.
- Ambos expostos em `GET /health` em `cache.*` e `rateLimit.*`.
