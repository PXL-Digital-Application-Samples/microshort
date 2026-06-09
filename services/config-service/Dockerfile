# Stage 1: Build
FROM node:26-slim AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm config set strict-ssl false && npm ci

# Copy source files
COPY . .

# Compile TypeScript
RUN npx tsc

# Run tests
RUN npx vitest run

# Stage 2: Production image
FROM node:26-slim

WORKDIR /app

# Copy only the build output and production dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./

RUN npm config set strict-ssl false && npm ci --omit=dev

CMD ["node", "dist/index.js"]
