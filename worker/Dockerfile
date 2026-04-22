FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json* ./
COPY worker/package.json ./worker/
RUN npm install --workspace @renate/worker --include-workspace-root

COPY worker ./worker
RUN npm run build --workspace @renate/worker

FROM node:22-slim
ENV NODE_ENV=production

# ffmpeg is used by finalize to concat per-session WAV chunks.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/worker/dist ./worker/dist
COPY --from=build /app/worker/package.json ./worker/package.json
COPY --from=build /app/package.json ./package.json

WORKDIR /app/worker
CMD ["node", "dist/index.js"]
