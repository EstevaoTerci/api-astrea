# API Astrea

API REST que expõe dados do sistema jurídico [Astrea](https://astrea.net.br) via HTTP requests autenticadas e scraping controlado com Playwright. Também expõe um endpoint MCP remoto para clientes compatíveis com o protocolo.

## Endpoints

| Método  | Rota                                            | Descrição                                              |
| ------- | ----------------------------------------------- | ------------------------------------------------------ |
| `GET`   | `/health`                                       | Health check                                           |
| `POST`  | `/api/clientes`                                 | Cria cliente/contato                                   |
| `GET`   | `/api/clientes`                                 | Buscar clientes (ver filtros abaixo)                   |
| `GET`   | `/api/clientes/todos`                           | Lista completa de todos os clientes (ver filtros)      |
| `GET`   | `/api/clientes/:id`                             | Detalhes do cliente (inclui documentos)                |
| `PATCH` | `/api/clientes/:id`                             | Atualiza parcialmente o cadastro (campos não passados ficam intactos) |
| `GET`   | `/api/clientes/:id/casos`                       | Casos/processos do cliente                             |
| `GET`   | `/api/casos/:id`                                | Detalhes completos de um caso/processo                 |
| `GET`   | `/api/casos/:id/andamentos`                     | Andamentos do caso                                     |
| `POST`  | `/api/atendimentos`                             | Agenda um atendimento                                  |
| `POST`  | `/api/atendimentos/:id/transformar-em-caso`     | Converte atendimento em caso                           |
| `POST`  | `/api/atendimentos/:id/transformar-em-processo` | Converte atendimento em processo                       |
| `POST`  | `/api/tarefas/:id/comentarios`                  | Adiciona comentário (texto puro) em tarefa             |

### Filtros nativos do Astrea (queryDTO) em `GET /api/clientes` e `GET /api/clientes/todos`

Mapeiam direto para o `queryDTO` do `POST /contact/all` interno do Astrea — aplicados server-side, **sem chamadas extras**. Cada filtro reduz a quantidade de dados trafegados e elimina a necessidade de buscar o detalhe individual de cada contato.

| Param           | Tipo            | Mapeia para                                | Disponível em                |
| --------------- | --------------- | ------------------------------------------ | ---------------------------- |
| `nome`          | `string`        | `queryDTO.text` (busca textual)            | `GET /api/clientes`          |
| `cpfCnpj`       | `string`        | `queryDTO.text` (com/sem máscara)          | `GET /api/clientes`          |
| `email`         | `string`        | filtro local pós-resposta                  | `GET /api/clientes`          |
| `mesAniversario`| `1..12`         | `queryDTO.birthMonth`                      | ambos                        |
| `estado`        | `string` (UF)   | `queryDTO.state`                           | ambos                        |
| `etiquetasIds`  | `number[]` (CSV ou repetido) | `queryDTO.selectedTagsIds`    | ambos                        |
| `apenasComEmail`| `boolean`       | `queryDTO.onlyWithEmail`                   | ambos                        |
| `buscarEmEmpresa`| `boolean`      | `queryDTO.searchInCompany`                 | apenas `GET /api/clientes`   |

**Caso de uso típico:** "aniversariantes do mês" passa de `1 + N` chamadas (1 para listar IDs + N para buscar detalhe de cada) para `1 + ~N/12` (a chamada inicial já filtra por mês — só os ~190 do mês precisam de detalhe, em vez de 2.300+ do total).

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
- `atualizar_cliente` — PATCH parcial no cadastro do contato (corrigir typo no nome, atualizar telefone/email/endereço/etc.). Campos não informados ficam intactos. Não permite alterar perfil/tipo (cliente↔contato, PF↔PJ) — para isso, use a UI do Astrea.
- `transformar_atendimento_em_caso`
- `transformar_atendimento_em_processo`
- `comentar_tarefa` — adiciona comentário em tarefa (texto puro; não aceita menção `@usuário` nem anexos nesta versão)

As tools de listagem `listar_clientes` e `listar_todos_clientes` também aceitam os filtros nativos do `queryDTO` documentados acima (`mesAniversario`, `estado`, `etiquetasIds`, `apenasComEmail`, `buscarEmEmpresa`).

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
