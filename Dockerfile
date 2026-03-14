# syntax=docker/dockerfile:1.7

# ─────────────────────────────────────────────────────────────────────
# Stage 1: Build TypeScript
# ─────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Copia manifestos de dependência e instala
COPY package*.json ./
# O Coolify pode injetar NODE_ENV=production em build-time.
# Forçamos a instalação das devDependencies no estágio de build
# para garantir a presença de TypeScript e demais ferramentas.
RUN npm ci --include=dev

# Copia código-fonte e compila
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ─────────────────────────────────────────────────────────────────────
# Stage 2: Runtime
# ─────────────────────────────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.44.0-jammy AS runtime

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

# Copia apenas dependências de produção
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copia os arquivos compilados
COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "dist/server.js"]
