FROM node:26-slim

WORKDIR /app

COPY --chown=node:node package*.json ./

RUN npm config set strict-ssl false && npm ci --omit=dev

COPY --chown=node:node . .

EXPOSE 3004

USER node
CMD ["node", "server.js"]
