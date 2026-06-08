FROM node:20-bookworm-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends libvips42 python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY *.ts ./
COPY utils/ utils/

FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends libvips42 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app .

EXPOSE 3001
CMD ["npm", "start"]
