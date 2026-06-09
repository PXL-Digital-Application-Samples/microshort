# Stage 1: Build and test
FROM node:26-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm config set strict-ssl false && npm ci

COPY . .

RUN npx tsc

RUN npx vitest run

# Stage 2: Production image
FROM node:26-slim

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --chown=node:node package*.json ./

RUN npm config set strict-ssl false && npm ci --omit=dev

COPY --chown=node:node config.schema.json ./config.schema.json

USER node
CMD ["node", "dist/index.js"]
