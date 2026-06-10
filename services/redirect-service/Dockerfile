FROM node:26-slim

WORKDIR /app

COPY --chown=node:node package*.json ./

# TODO: replace with corporate CA cert installation when cert is available
#   (RUN apt-get install -y ca-certificates && COPY corp-ca.crt /usr/local/share/ca-certificates/ && update-ca-certificates)
#   Until then, strict-ssl false is a documented workaround for the corporate SSL proxy.
RUN npm config set strict-ssl false && npm ci --omit=dev

COPY --chown=node:node src/ ./src/

EXPOSE 8080

USER node
CMD ["node", "src/index.js"]
