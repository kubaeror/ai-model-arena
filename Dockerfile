# ── build stage ──
FROM node:26.7.0-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3=3.11.2-1+b1 make=4.3-4.1 g++=4:12.2.0-3 libargon2-dev=0~20171227-0.3+deb12u1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --include=dev
COPY tsconfig.json drizzle.config.ts drizzle.pg.config.ts ./
COPY src ./src
COPY configs ./configs
COPY drizzle ./drizzle
RUN npm run build
# Fail the build on any high/critical production vulnerability. Aligned with
# the CI gate in .github/workflows/pr-checks.yaml. Previously this was
# `npm audit --production || true` which silently ignored every CVE including
# critical ones in the shipped image.
RUN npm audit --audit-level=high --production && npm prune --production

# ── dashboard client build ──
FROM node:26.7.0-bookworm-slim AS client-build
WORKDIR /app/src/dashboard-client
COPY src/dashboard-client/package*.json ./
RUN npm ci
COPY src/dashboard-client/ ./
RUN npm run build

# ── runtime stage ──
# Healthchecks live in docker-compose.yml only (node one-liner on :4000 for the
# dashboard). An image-level HEALTHCHECK would lie for the runner role, which
# serves /metrics on :4001 and never binds :4000.
FROM node:26.7.0-bookworm-slim AS runtime
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends libargon2-1=0~20171227-0.3+deb12u1 && rm -rf /var/lib/apt/lists/*
# npm is not needed at runtime (CMD runs node directly). The base image's
# bundled npm ships vulnerable transitive deps (brace-expansion, ip-address)
# that Trivy flags — remove it instead of shipping ~30MB of unused tooling.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
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
USER 10001
ENV OUTPUT_ROOT=/var/arena/outputs
CMD ["node", "dist/runner-entry.js"]
