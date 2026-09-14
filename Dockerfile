# Grupo Sampaio ERP — imagem de produção: a API e as telas no mesmo processo.
#
# O frontend é buildado aqui e servido pela própria API
# (DEVORA_SERVIR_FRONTEND=true), com fallback de SPA (GAP-PRD-013). O HTTPS
# termina no proxy da frente — `docker compose --profile https` sobe o Caddy.
# Ver docs/DEPLOY.md, seção "Docker".

FROM node:24-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY server/package*.json ./server/
RUN npm ci && npm ci --prefix server
# O contexto é só código: `.dockerignore` deixa de fora banco, backups, fotos,
# .env e node_modules (GAP-PRD-061).
COPY . .
# O endereço da API é EMBUTIDO no bundle. `/` é a própria origem que serviu a
# página: a API serve as telas, e o proxy da frente encaminha tudo para ela.
ARG VITE_API_BASE_URL=/
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
RUN npm run build && npm prune --omit=dev --prefix server

FROM node:24-alpine
WORKDIR /app

# Produção pelos DOIS nomes (GAP-PRD-151): as travas do servidor valem por
# qualquer um deles, mas o log, as integrações e a base fiscal leem
# DEVORA_API_ENV — e ela só existe se alguém escrever.
#
# TODO DADO MORA EM VOLUME (GAP-PRD-062). Sem DEVORA_UPLOADS_DIR as fotos iam
# para o padrão histórico `<raiz>/data/uploads` = /app/data/uploads, fora do
# volume: recriar o container apagava as fotos de produto, de loja e de OS, e o
# banco continuava apontando para elas. O backup vai para OUTRO volume — backup
# no mesmo lugar do banco não é backup.
ENV NODE_ENV=production \
    DEVORA_API_ENV=production \
    DEVORA_API_PORT=8787 \
    DEVORA_DATABASE_PATH=/app/server/data/grupo-sampaio.db \
    DEVORA_UPLOADS_DIR=/app/server/data/uploads \
    DEVORA_BACKUP_DIR=/app/backups     DEVORA_SERVIR_FRONTEND=true     DEVORA_FRONTEND_DIR=/app/out

COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/server/package*.json ./server/
COPY --from=builder /app/server/node_modules ./server/node_modules
# Os XSD oficiais da NF-e/NFC-e e o MANIFESTO com o SHA-256 de cada um
# (GAP-PRD-097). O validador os procura ao lado de `server/dist`
# (`../../../fiscal-schemas` a partir de `dist/services/core`): sem esta
# cópia a imagem de produção não tem contra o que conferir o leiaute.
COPY --from=builder /app/server/fiscal-schemas ./server/fiscal-schemas
COPY --from=builder /app/out ./out

# A pasta de dados e a de backup nascem do usuário `node`: um volume nomeado
# novo herda o dono desta pasta, e o processo não roda como root.
RUN mkdir -p /app/server/data/uploads /app/backups \
    && chown -R node:node /app/server/data /app/backups
VOLUME ["/app/server/data", "/app/backups"]
USER node

EXPOSE 8787
# /readiness abre o banco de verdade (503 se não abre); /health só diz que o
# processo respondeu. O início é generoso porque o boot migra o banco.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.DEVORA_API_PORT||8787)+'/api/v1/readiness').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server/dist/index.js"]
