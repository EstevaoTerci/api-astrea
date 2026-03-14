# syntax=docker/dockerfile:1.7

# ─────────────────────────────────────────────────────────────────────
# Stage 1: Build TypeScript
# ─────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Copia manifestos de dependência e instala
COPY package*.json ./
RUN npm ci

# Copia código-fonte e compila
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ─────────────────────────────────────────────────────────────────────
# Stage 2: Runtime
# ─────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
  chromium \
  ca-certificates \
  dumb-init \
  fonts-liberation \
  wget \
  && rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    BROWSER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Copia apenas dependências de produção
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copia os arquivos compilados
COPY --from=builder /app/dist ./dist

# Usuário não-root para segurança
RUN groupadd --system appgroup && useradd --system --gid appgroup appuser \
  && chown -R appuser:appgroup /app
USER appuser

ENV NODE_ENV=production

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
