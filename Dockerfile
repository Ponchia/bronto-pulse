FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY web ./web
COPY examples ./examples
RUN npm run build && npm prune --omit=dev --ignore-scripts
FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/web ./web
COPY --from=build --chown=node:node /app/examples ./examples
COPY --chown=node:node package.json ./
USER node
VOLUME ["/app/.pulse"]
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["--help"]
