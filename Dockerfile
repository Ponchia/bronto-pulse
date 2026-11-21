FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY web ./web
COPY examples ./examples
RUN npm run build && npm prune --omit=dev --ignore-scripts
FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/web ./web
COPY --from=build --chown=node:node /app/examples ./examples
COPY --chown=node:node package.json ./
COPY --chown=node:node deploy ./deploy
USER node
VOLUME ["/app/.pulse"]
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["--help"]
