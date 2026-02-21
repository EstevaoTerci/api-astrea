# API Astrea

API REST que expõe dados do sistema jurídico [Astrea](https://astrea.net.br) via HTTP requests autenticadas e scraping controlado com Playwright.

## Endpoints

| Método | Rota | Descrição |
|--------|------|-----------|
| `GET` | `/health` | Health check |
| `GET` | `/api/clientes` | Buscar clientes por nome (`?nome=`) |
| `GET` | `/api/clientes/todos` | Lista completa de todos os clientes |
| `GET` | `/api/clientes/:id` | Detalhes do cliente (inclui documentos) |
| `GET` | `/api/clientes/:id/casos` | Casos/processos do cliente |
| `GET` | `/api/casos/:id` | Detalhes completos de um caso/processo |
| `GET` | `/api/casos/:id/andamentos` | Andamentos do caso |

## Autenticação

Todas as rotas `/api/*` requerem header `x-api-key` com o valor definido em `API_KEY`.

## Deploy com Docker

```bash
# 1. Copiar e preencher variáveis de ambiente
cp .env.example .env

# 2. Subir com Docker Compose
docker compose up -d --build
```

### Coolify

1. Crie uma nova stack no Coolify
2. Use o `docker-compose.yml` do repositório
3. Configure as variáveis de ambiente no painel do Coolify (mesmas do `.env.example`)

## Desenvolvimento local

```bash
npm install
cp .env.example .env  # Preencha com suas credenciais
npm run dev
```

## Stack

- **Runtime**: Node.js 22 + TypeScript
- **Framework**: Express.js
- **Browser**: Playwright (Chromium headless)
- **Deploy**: Docker multi-stage build (Alpine)
