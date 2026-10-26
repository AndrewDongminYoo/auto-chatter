FROM node:26-bookworm-slim AS dependencies
WORKDIR /app
# Node.js 25+ no longer bundles Corepack, so install the userland package before enabling it.
RUN npm install -g corepack@0.36.0 && corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM node:26-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
USER node
EXPOSE 3000
CMD ["node", "src/instagram/main.ts"]
