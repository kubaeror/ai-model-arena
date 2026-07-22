# ── build stage ──
FROM node:26-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ libargon2-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --include=dev
RUN npm prune --production
COPY tsconfig.json drizzle.config.ts drizzle.pg.config.ts ./
COPY src ./src
COPY configs ./configs
COPY drizzle ./drizzle
RUN npm run build

# ── dashboard client build ──
FROM node:26-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb AS client-build
WORKDIR /app/src/dashboard-client
COPY src/dashboard-client/package*.json ./
RUN npm ci
COPY src/dashboard-client/ ./
RUN npm run build

# ── runtime stage ──
FROM node:26-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends libargon2-1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
RUN useradd -r -u 10001 -g users arena && \
    mkdir -p /app /var/arena/outputs /app/src/dashboard-client && \
    chown -R arena:users /app /var/arena
COPY --from=build --chown=arena:users /app/node_modules ./node_modules
COPY --from=build --chown=arena:users /app/dist ./dist
COPY --from=build --chown=arena:users /app/drizzle ./drizzle
COPY --from=build --chown=arena:users /app/configs ./configs
COPY --from=build --chown=arena:users /app/package.json ./
COPY --from=client-build --chown=arena:users /app/src/dashboard-client/dist ./src/dashboard-client/dist
USER arena
ENV OUTPUT_ROOT=/var/arena/outputs
CMD ["node", "dist/runner-entry.js"]
