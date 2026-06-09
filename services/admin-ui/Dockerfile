FROM node:26-slim

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm config set strict-ssl false && npm ci --omit=dev

# Copy all UI files
COPY . .

# Expose port
EXPOSE 3004

# Start the server
CMD ["node", "server.js"]
