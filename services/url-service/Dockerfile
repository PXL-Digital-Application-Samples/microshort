FROM node:26-slim

WORKDIR /app

COPY --chown=node:node package*.json ./

RUN npm ci --omit=dev

COPY --chown=node:node src/ ./src/

EXPOSE 3002

USER node
CMD ["node", "src/index.js"]
