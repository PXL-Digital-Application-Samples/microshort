# Stage 1: Build
FROM node:24-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

RUN npx tsc
RUN npm run test -- --run

# Stage 2: Production image
FROM node:24-slim

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./

RUN npm install --omit=dev

CMD ["node", "dist/index.js"]
