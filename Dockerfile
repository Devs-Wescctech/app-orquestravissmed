# ---------- Stage 1: builder ----------
# Builda API (NestJS/tsc) e Web (Next.js) num monorepo npm workspaces.
FROM node:20-bookworm-slim AS builder

# openssl e ca-certificates sao necessarios para o Prisma Engine.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 1) Instala dependencias com o cache de layers otimizado: copia so os manifests.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci

# 2) Copia o codigo-fonte (o .dockerignore filtra artefatos e scripts temporarios).
COPY . .

# 3) Gera o Prisma Client.
RUN npx prisma generate --schema=apps/api/prisma/schema.prisma

# 4) Builda a API (tsc -> apps/api/dist) e o frontend (next build -> apps/web/.next).
RUN cd apps/api && npx tsc -p tsconfig.json
RUN cd apps/web && npm run build

# 5) Remove devDependencies para enxugar node_modules e regenera o Prisma Client
#    (prisma continua como dependency da API, entao segue disponivel em runtime).
RUN npm prune --omit=dev \
    && npx prisma generate --schema=apps/api/prisma/schema.prisma

# ---------- Stage 2: runtime ----------
# Mesma base (bookworm-slim) para garantir compatibilidade do Prisma Engine (native target).
FROM node:20-bookworm-slim AS runner

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV VISMED_API_PORT=3000
WORKDIR /app

# Dependencias de producao (com Prisma Client ja gerado).
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json

# Artefatos e arquivos de runtime da API.
COPY --from=builder /app/apps/api/package.json ./apps/api/package.json
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/prisma ./apps/api/prisma
# Scripts de manutencao/migracao one-off (ex.: fix-service-dict-ids.js).
COPY --from=builder /app/apps/api/scripts ./apps/api/scripts

# Artefatos e arquivos de runtime do Web.
COPY --from=builder /app/apps/web/package.json ./apps/web/package.json
COPY --from=builder /app/apps/web/.next ./apps/web/.next
COPY --from=builder /app/apps/web/public ./apps/web/public
COPY --from=builder /app/apps/web/next.config.js ./apps/web/next.config.js

# Script de inicializacao (db push + seed idempotentes + sobe os dois processos).
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# Somente a porta do frontend precisa ser exposta (ele proxia /api/* para a API local).
EXPOSE 5000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
