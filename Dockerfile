FROM node:22.18-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY web ./web
COPY site ./site
ENV NODE_ENV=production PORT=8787 DB_PATH=/data/firstprint.db
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 8787
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
