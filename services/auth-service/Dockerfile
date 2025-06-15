FROM node:24-slim

WORKDIR /app

# Copy package.json (no package-lock.json needed)
COPY package.json ./

# Install dependencies (will generate package-lock.json)
RUN npm install --omit=dev

# Copy application code
COPY src/ ./src/

# Expose port
EXPOSE 3001

# Start the service
CMD ["node", "src/index.js"]