FROM node:24-slim

WORKDIR /app

# Copy package.json
COPY package.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy application code
COPY src/ ./src/

# Expose port
EXPOSE 8080

# Start the service
CMD ["node", "src/index.js"]
