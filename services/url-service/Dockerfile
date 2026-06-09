FROM node:26-slim

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm config set strict-ssl false && npm ci --omit=dev

# Copy application code
COPY src/ ./src/

# Expose port
EXPOSE 3002

# Start the service
CMD ["node", "src/index.js"]
