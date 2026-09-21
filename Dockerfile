FROM node:20-slim AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY tsconfig.json ./
COPY src ./src
COPY tests ./tests

RUN npm run test:helpdesk
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

RUN mkdir -p /app/data

EXPOSE 8192

HEALTHCHECK --interval=5s --timeout=4s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8192)+'/health',{signal:AbortSignal.timeout(3000)}).then(async r=>{if(!r.ok||(await r.json()).status!==true)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]

