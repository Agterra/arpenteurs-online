# syntax=docker/dockerfile:1
# Multi-stage build for the Nuxt 4 / Nitro app. Produces a small runtime image
# that runs the prebuilt .output server. Prisma 7's client is engine-less, so no
# native engine binaries need shipping.

# ---- deps: install with a warm pnpm store cache ----
FROM node:24-alpine AS deps
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma
COPY prisma.config.ts ./
# postinstall runs `nuxt prepare && prisma generate`; nuxt prepare needs the app,
# so skip lifecycle scripts here and generate the Prisma client explicitly.
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts \
 && pnpm exec prisma generate

# ---- build: compile the Nuxt/Nitro output ----
FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/server/generated ./server/generated
COPY . .
# The app version is read from package.json by nuxt.config.ts at build time and
# baked into public runtime config — no build arg needed.
ENV NODE_ENV=production
RUN pnpm build

# ---- migrate deps: prisma CLI + schema for the migration Job ----
# (kept minimal so the migration image is the same base as runtime)
FROM node:24-alpine AS runtime
RUN corepack enable && addgroup -g 65532 -S nonroot && adduser -u 65532 -S nonroot -G nonroot
WORKDIR /app
ENV NODE_ENV=production \
    NITRO_PORT=3000 \
    NITRO_HOST=0.0.0.0
# The self-contained Nitro server bundle…
COPY --from=build /app/.output ./.output
# …plus the Prisma schema/config and the FULL node_modules so the k8s migration
# init container can run `prisma migrate deploy` from this same image. We copy
# node_modules whole (not cherry-picked): the prisma CLI lives behind pnpm
# symlinks into node_modules/.pnpm/…, and its schema-engine + deps only resolve
# when that store is present. The app itself runs from the bundled .output and
# doesn't need node_modules — this is purely for the migrate step.
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./prisma.config.ts
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
# Catalog import scripts (raw pg-based, run via `compose run --rm app node
# scripts/import-cards.ts` to seed the deployed DB). They import scripts/lib +
# shared/utils only, and write a download cache to /app/.cache — which must be
# writable by the nonroot uid the container runs as.
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/shared ./shared
RUN mkdir -p /app/.cache && chown -R 65532:65532 /app/.cache
USER nonroot
EXPOSE 3000
# Default: run the app. The migration Job overrides this with `prisma migrate deploy`.
CMD ["node", ".output/server/index.mjs"]
