FROM node:26-slim

WORKDIR /app

COPY --chown=node:node package*.json ./

RUN npm ci --omit=dev

COPY --chown=node:node server.js ./
COPY --chown=node:node public ./public

EXPOSE 3004

USER node
CMD ["node", "server.js"]
