FROM node:24-slim

WORKDIR /app

# Copy package.json
COPY package.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy all UI files
COPY . .

# Expose port
EXPOSE 3004

# Start the server
CMD ["node", "server.js"]
