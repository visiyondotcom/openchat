FROM node:20-bookworm-slim AS base
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/dist ./dist
COPY --from=base /app/prisma ./prisma
COPY package.json ./

EXPOSE 4000

# Sync the schema (no migration history yet — run `prisma migrate dev`
# locally once you want versioned migrations) then boot the server.
# --accept-data-loss: this runs non-interactively, so db push can't prompt
# for confirmation when a schema change looks destructive (e.g. renaming a
# column shows up as drop+add) — without this flag it just exits and the
# container never comes up. Fine here since QuotaUsage/Group quota columns
# are the only things ever renamed/dropped this way, and losing a day of
# usage counters or a re-typed quota number is harmless.
CMD ["sh", "-c", "npx prisma db push --skip-generate --accept-data-loss && node dist/index.js"]
