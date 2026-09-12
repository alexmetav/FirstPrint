FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY web ./web
COPY scripts ./scripts
ENV NODE_ENV=production PORT=8787 DB_PATH=/data/firstprint.db
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 8787
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
