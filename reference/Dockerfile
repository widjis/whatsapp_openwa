FROM node:20-slim AS deps

WORKDIR /app

COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci

FROM node:20-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY tsconfig.json ./
COPY src ./src
COPY index.html ./

RUN npm run build
RUN npm prune --omit=dev

FROM node:20-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/index.html ./index.html

RUN mkdir -p /app/data

EXPOSE 8192

CMD ["node", "dist/index.js"]
