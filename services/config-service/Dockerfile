# Stage 1: Build
FROM node:24-slim AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy source files
COPY . .

# Compile TypeScript
RUN npx tsc

# Run tests
RUN npx vitest run

# Stage 2: Production image
FROM node:24-slim

WORKDIR /app

# Copy only the build output and production dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./

RUN npm install --omit=dev

# Copy config.json if it exists at build time
COPY config.json ./config.json

CMD ["node", "dist/index.js"]
