FROM oven/bun:1

# sharp 需要 libvips；bun:sqlite 是内置，无需编译
RUN apt-get update && apt-get install -y --no-install-recommends libvips42 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json .
RUN bun install --production

COPY index.ts .

EXPOSE 3001
CMD ["bun", "run", "index.ts"]
