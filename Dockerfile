# ── build stage ──
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --include=dev
COPY tsconfig.json drizzle.config.ts drizzle.pg.config.ts ./
COPY src ./src
COPY configs ./configs
COPY drizzle ./drizzle
RUN npm run build

# ── runtime stage ──
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN useradd -r -u 10001 -g users arena && \
    mkdir -p /app /var/arena/outputs && \
    chown -R arena:users /app /var/arena
COPY --from=build --chown=arena:users /app/node_modules ./node_modules
COPY --from=build --chown=arena:users /app/dist ./dist
COPY --from=build --chown=arena:users /app/drizzle ./drizzle
COPY --from=build --chown=arena:users /app/configs ./configs
COPY --from=build --chown=arena:users /app/package.json ./
USER arena
ENV OUTPUT_ROOT=/var/arena/outputs
CMD ["node", "dist/runner.js"]
