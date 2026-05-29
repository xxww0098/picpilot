FROM oven/bun:1 AS build

RUN apt-get update && apt-get install -y --no-install-recommends libvips42 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY index.ts config.ts concurrencyQueue.ts ./
COPY utils/ utils/

FROM oven/bun:1

RUN apt-get update && apt-get install -y --no-install-recommends libvips42 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app .

EXPOSE 3001
CMD ["bun", "run", "index.ts"]
