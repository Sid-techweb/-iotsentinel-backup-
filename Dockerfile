# Cloud image: ONE container that serves the React app and the REST API (used by render.yaml).
# Local development keeps using docker-compose.yml with the separate backend / frontend images.

FROM node:22-alpine AS web
WORKDIR /web
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:22-alpine AS api
WORKDIR /app
COPY backend/package*.json ./
RUN npm ci
COPY backend/tsconfig.json backend/tsconfig.build.json ./
COPY backend/src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    STATIC_DIR=/app/public \
    DATA_DIR=/data \
    UPLOAD_DIR=/data/uploads \
    DOCS_DIR=/app/docs
COPY backend/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=api /app/dist ./dist
COPY backend/models ./models
COPY backend/migrations ./migrations
COPY --from=web /web/dist ./public
COPY docs ./docs
RUN mkdir -p /data/uploads && chown -R node:node /app/models /data
USER node
EXPOSE 4000
CMD ["node", "dist/index.js"]
