# ─────────────────────────────────────────────────────────────────────
# Stage 1: Build TypeScript
# ─────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

# Aplica patches de segurança disponíveis no Alpine
RUN apk upgrade --no-cache

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
FROM node:22-alpine AS runtime

# Aplica patches de segurança disponíveis no Alpine
RUN apk upgrade --no-cache

# Chromium e dependências via Alpine (sem baixar bundle separado do Playwright)
RUN apk add --no-cache \
  chromium \
  nss \
  freetype \
  freetype-dev \
  harfbuzz \
  ca-certificates \
  ttf-freefont \
  wget \
  udev

# Informa ao Playwright para usar o Chromium do sistema Alpine
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR /app

# Copia apenas dependências de produção
COPY package*.json ./
RUN npm ci --omit=dev

# O Playwright usa o Chromium do sistema — sem download adicional

# Copia os arquivos compilados
COPY --from=builder /app/dist ./dist

# Usuário não-root para segurança
RUN addgroup -S appgroup && adduser -S appuser -G appgroup \
  && chown -R appuser:appgroup /app
USER appuser

ENV NODE_ENV=production

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "dist/server.js"]
