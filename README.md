# API Astrea

API REST que expõe dados do sistema jurídico [Astrea](https://astrea.net.br) via HTTP requests autenticadas e scraping controlado com Playwright. Também expõe um endpoint MCP remoto para clientes compatíveis com o protocolo.

## Endpoints

| Método | Rota                                            | Descrição                               |
| ------ | ----------------------------------------------- | --------------------------------------- |
| `GET`  | `/health`                                       | Health check                            |
| `POST` | `/api/clientes`                                 | Cria cliente/contato                    |
| `GET`  | `/api/clientes`                                 | Buscar clientes por nome (`?nome=`)     |
| `GET`  | `/api/clientes/todos`                           | Lista completa de todos os clientes     |
| `GET`  | `/api/clientes/:id`                             | Detalhes do cliente (inclui documentos) |
| `GET`  | `/api/clientes/:id/casos`                       | Casos/processos do cliente              |
| `GET`  | `/api/casos/:id`                                | Detalhes completos de um caso/processo  |
| `GET`  | `/api/casos/:id/andamentos`                     | Andamentos do caso                      |
| `POST` | `/api/atendimentos`                             | Agenda um atendimento                   |
| `POST` | `/api/atendimentos/:id/transformar-em-caso`     | Converte atendimento em caso            |
| `POST` | `/api/atendimentos/:id/transformar-em-processo` | Converte atendimento em processo        |

## Autenticação

Todas as rotas `/api/*` e `/mcp` requerem header `x-api-key` com o valor definido em `API_KEY`.

## MCP remoto

O projeto mantém o servidor MCP em `stdio` para integrações locais e também expõe um endpoint HTTP remoto em `/mcp`.

- URL: `POST/GET/DELETE /mcp`
- Transporte: `Streamable HTTP`
- Header obrigatório: `x-api-key: <API_KEY>`
- Sessão: o cliente inicializa a sessão com `POST /mcp`; o servidor devolve `Mcp-Session-Id` e o cliente reutiliza esse header nas chamadas seguintes

Para clientes remotos, prefira apontar para a URL interna do serviço no Coolify, por exemplo `http://api-astrea:3000/mcp`, ou para um domínio publicado se você decidir expor esse endpoint externamente.

As operações de mutação novas também ficam disponíveis no MCP remoto/stdio:

- `criar_cliente`
- `transformar_atendimento_em_caso`
- `transformar_atendimento_em_processo`

## Deploy com Docker

```bash
# 1. Copiar e preencher variáveis de ambiente
cp .env.example .env

# 2. Subir com Docker Compose local
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
```

## Coolify

Use o `docker-compose.yml` do repositório como arquivo principal da resource `Docker Compose`.

1. Crie uma nova resource do tipo `Docker Compose` no Coolify apontando para este repositório.
2. Use apenas o arquivo `docker-compose.yml` no deploy da VPS.
3. Configure as variáveis de ambiente no painel do Coolify. O compose já declara todas explicitamente para o UI detectá-las.
4. Mantenha `TRUST_PROXY=1` quando a API ficar atrás do proxy do Coolify.
5. Se a API for usada apenas por `n8n` e outros serviços internos, prefira acesso interno em rede e não publique porta/URL desnecessariamente.

### Variáveis mínimas de produção

- `ASTREA_EMAIL`
- `ASTREA_PASSWORD`
- `API_KEY`

### Recomendação inicial para VPS pequena

- `NODE_ENV=production`
- `TRUST_PROXY=1`
- `BROWSER_HEADLESS=true`
- `BROWSER_POOL_SIZE=3`
- `BROWSER_IDLE_TTL_MS=900000`
- `RATE_LIMIT_MAX_REQUESTS=60`

### Rede com n8n

Se o `n8n` estiver na mesma stack/rede do Coolify, prefira chamadas internas na porta `3000`.

Se o `n8n` estiver em outra stack, as opções práticas são:

- expor um domínio protegido por `x-api-key`
- ligar ambas as stacks a uma rede compartilhada no Docker/Coolify

## Observações de produção

- O compose principal não fixa `container_name`, o que evita conflito em re-deploys do Coolify.
- O compose principal não publica porta no host. Para rodar localmente, use o override `docker-compose.local.yml`.
- O projeto usa um único browser/contexto com sessão compartilhada e fecha cada aba ao final da requisição.
- O browser usa lazy init e é encerrado automaticamente após o TTL de ociosidade configurado.
- O runtime de produção usa a imagem oficial do Playwright para manter o browser alinhado com a versão instalada no projeto.

## Desenvolvimento local

```bash
npm install
cp .env.example .env
npm run dev
```

## Stack

- Runtime: Node.js 22 + TypeScript
- Framework: Express.js
- Browser: Playwright
- Deploy: Docker multi-stage build
