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

- `listarClientes` e `listarAniversariantesEnriquecidos` têm cache server-side com TTL 60s + inflight dedup ([src/utils/cache.ts](src/utils/cache.ts), `InflightTtlCache`). Só cobrem filtros estruturais (mesAniversario, estado, etiquetas); buscas livres (nome/cpfCnpj/email) pulam cache por cardinalidade alta.
- Rate limit é por IP, default 50 req/60s ([src/middleware/rate-limiter.ts](src/middleware/rate-limiter.ts)). Excedente recebe 429 com `Retry-After`. Cobre defesa contra retry-storm de consumer mal-comportado.
- Ambos expostos em `GET /health` em `cache.*` e `rateLimit.*`.

## Doutrina de endpoints

### REST direto > DOM scrape

A primeira pergunta ao implementar qualquer fluxo novo: **existe endpoint REST nativo do Astrea pra isso?** A resposta foi "sim" para cada caso já investigado (`/case/query`, `/documents/all`, `/calendar-pro/complete`, `/contact/all`, `/report/contactdetail`). DOM scrape com Playwright (`$state.go` + `waitForSelector` + leitura de scope) é frágil, lento (15-45s por chamada quando o DOM muda), e o Astrea altera o HTML sem aviso.

Quando precisar descobrir um endpoint, use Playwright em modo visível (`headless: false`) e capture as requests da UI real — registrar listeners de network ANTES de qualquer ação, e atenção a abas novas (`context.on('page')` é essencial pra rastrear janelas que o Astrea abre via `target=_blank` ou `window.open`). Padrão de script de discovery em [scripts/discover-birthdays-batch.mjs](scripts/discover-birthdays-batch.mjs).

### Endpoint preferido por caso de uso

- **Varredura de aniversariantes** (`mesAniversario` em janelas de dias/mês): use `listar_aniversariantes(mes)` — retorna `Cliente[]` JÁ com `dataNascimento`, `cpfCnpj`, telefone, email em UMA chamada. NÃO use o padrão antigo `listar_todos_clientes(mes) + N×buscar_cliente(id)` — esse caminho ainda existe, mas custa N round-trips em vez de 1.
- **Buscar 1 contato específico por id**: `buscar_cliente(id)` (sem `incluirDocumentos`). Default é rápido; passe `{incluirDocumentos: true}` apenas se realmente precisa do array `documentos[]`.
- **Lista paginada com filtros para UI** (busca por nome, cpf, etc): `listar_clientes(...)`.
- **Lista completa simples** (só id+nome+telefone, sem birthDate/cpf): `listar_todos_clientes(...)`. Mais leve que `listar_aniversariantes`, mas NÃO traz dados de cadastro completos.

## Desenvolvimento (modo dev)

**Aplica-se APENAS quando você está codando, refatorando ou debugando este projeto** — ou seja, qualquer turno em que vá editar arquivos de `src/`, mexer em `package.json`, criar/alterar testes, ou rodar build/lint. Em modo prod/operacional (diagnóstico de logs em produção, restart de container, leitura de Coolify), estas regras NÃO se aplicam.

### TDD obrigatório a partir de 2026-05-19

A suite vive em [test/](test/) (setup + helpers + fixtures) e em arquivos `*.test.ts` colocados ao lado do código que testam (`src/**/*.test.ts`). Stack: **Vitest** + **supertest** + **@vitest/coverage-v8**. Browser/Astrea **sempre mockados** — Playwright real nunca roda em teste (lento + risco de ban da conta na Astrea, igual ao explicado no teto do `BROWSER_POOL_SIZE`).

Ritual:

1. **Red** — escreve teste que falha (fixa o contrato).
2. **Green** — mínimo de código para passar.
3. **Refactor** — limpa sem quebrar.

Regras invioláveis no modo dev:

- **Feature nova** → teste antes do código. Se o teste passa de primeira sem falhar uma vez, ele provavelmente não está testando o que você acha.
- **Bug fix** → primeiro escreve teste reproduzindo o bug (rodar e ver vermelho), depois o fix (rodar e ver verde). Sem teste de regressão, o bug volta.
- **Mudança de contrato de rota/payload/header/código de erro** → atualizar testes em `routes/*.test.ts` no MESMO commit. O consumer principal (`assistente-claude-escritorio`) depende desse contrato.
- **Nunca commit com testes vermelhos.** Se `npm test` falha, o commit não sai. Hook do git pode ser adicionado depois — por ora é disciplina manual.
- **Cobertura** mínima na suite total: 70%. Camada utils ≥90%, middleware ≥85%, services ≥70%, routes ≥60%. Verificar com `npm run test:coverage`.

Comandos:

```bash
npm test               # roda toda a suite uma vez (CI mode)
npm run test:watch     # modo watch durante desenvolvimento
npm run test:coverage  # gera relatório de cobertura em coverage/
```

### Camadas de teste (onde colocar o quê)

- **Unit puro** (`utils/*.test.ts`, `browser/request-queue.test.ts`): sem I/O, sem Playwright, sem Express. Use `vi.useFakeTimers()` para tempo.
- **Middleware integration** (`middleware/*.test.ts`): supertest contra mini-app montado no próprio teste. NÃO importa `server.ts` (que sobe pool de browser real).
- **Service integration** (`services/*.service.test.ts`): mocka `browser/astrea-http.ts` via `vi.mock()`. Foco: payload enviado, mapeamento da resposta, propagação de erros, chave de cache correta.
- **Route integration** (`routes/*.routes.test.ts`): mocka o `service` correspondente via `vi.mock()`. Foco: parsing Zod, status codes, formato `ApiResponse`/`ApiError`, paginação.

### Não-escopo dos testes

- ❌ E2E contra Astrea real (lento + risco de ban)
- ❌ Playwright real
- ❌ Testes que dependem da rede externa, do Coolify ou do email SMTP
- ❌ MCP server (escopo separado, fica para depois)
