FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY web ./web
COPY examples ./examples
RUN npm run build && npm prune --omit=dev --ignore-scripts
FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
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
