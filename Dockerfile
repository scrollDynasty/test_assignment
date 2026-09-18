# ---- build: compile shared + server, bundle the web app ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
# Toolchain only in case better-sqlite3 has to compile from source (prebuilt binaries are used when available).
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# ---- runtime: one process serves the API and the built SPA ----
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/data/funnel.db
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/server/package.json apps/server/
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/dist apps/web/dist
# The initial version seeded on an empty database; later versions are published at runtime via the admin API.
COPY funnel-v1.json funnel-v2.json funnel-v3.json ./
EXPOSE 8080
CMD ["node", "apps/server/dist/main.js"]
