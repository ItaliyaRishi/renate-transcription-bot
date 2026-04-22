FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json* ./
COPY api/package.json ./api/
RUN npm install --workspace @renate/api --include-workspace-root

COPY api ./api
RUN npm run build --workspace @renate/api

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/api/dist ./api/dist
COPY --from=build /app/api/package.json ./api/package.json
COPY --from=build /app/package.json ./package.json

WORKDIR /app/api
EXPOSE 3000
CMD ["node", "dist/index.js"]
