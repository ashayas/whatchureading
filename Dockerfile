FROM node:22-bookworm AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl build-essential pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/* \
    && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable \
    && . "$HOME/.cargo/env" \
    && rustup target add wasm32-unknown-unknown \
    && cargo install worker-build --version 0.8.7 --locked
ENV PATH="/root/.cargo/bin:${PATH}"
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm run build:api

FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=8787 DATA_DIR=/data
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/build ./build
COPY --from=build --chown=node:node /app/migrations ./migrations
COPY --from=build --chown=node:node /app/wrangler.selfhost.jsonc ./wrangler.selfhost.jsonc
COPY --from=build --chown=node:node /app/mcp.wrangler.selfhost.jsonc ./mcp.wrangler.selfhost.jsonc
COPY --from=build --chown=node:node /app/mcp-worker ./mcp-worker
COPY --from=build --chown=node:node /app/scripts/selfhost-entry.mjs ./scripts/selfhost-entry.mjs
RUN mkdir /data && chown node:node /data /app
USER node
EXPOSE 8787
VOLUME ["/data"]
CMD ["node", "scripts/selfhost-entry.mjs"]
