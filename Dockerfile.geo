FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 poppler-utils && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --chown=node:node geo/ ./geo/
RUN mkdir /data && chown node:node /data && chmod 700 /data
USER node
ENV NODE_ENV=production GEO_PORT=3100 GEO_DB=/data/geo.sqlite GEO_CONTAINER_BIND=1
EXPOSE 3100
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:3100/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node","geo/server.mjs"]
