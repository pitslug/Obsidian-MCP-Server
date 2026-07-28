# syntax=docker/dockerfile:1

# Debian rather than Alpine, deliberately. `leveldown` — which backs the local
# PouchDB replica — ships prebuilt binaries for glibc but not musl, so Alpine
# would force a native compile at image build time: a C++ toolchain in the
# image, a slower build, and a new way for the thing to break on an unrelated
# day. The extra ~120 MB buys a build with no compiler in it.

FROM node:22-bookworm-slim AS build
WORKDIR /app

# Dependencies first, so a source-only change does not re-resolve the tree.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build


FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Production dependencies only: the differential tests pull in the whole
# plugin library, which has no business in a running container.
RUN npm ci --omit=dev


FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    REPLICA_PATH=/data/replica \
    INDEX_PATH=/data/index.sqlite \
    MCP_TRANSPORT=http \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=8080 \
    READ_ONLY=true

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# The replica and index are derived data; both are safe to destroy and will
# rebuild from CouchDB on the next start.
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]

USER node
EXPOSE 8080

# Uses the server's own /health endpoint, which is deliberately not behind the
# bearer token and deliberately says nothing about the vault.
HEALTHCHECK --interval=1m --timeout=10s --retries=2 --start-period=60s \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.MCP_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
