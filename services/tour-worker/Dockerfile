# Build từ thư mục gốc repo: docker build -f services/tour-worker/Dockerfile .
FROM node:22-alpine
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json ./
COPY services/tour-worker/package.json services/tour-worker/
COPY packages/channels/package.json packages/channels/
COPY packages/channels/src packages/channels/src
RUN pnpm install --filter @tours/worker... --prod --no-frozen-lockfile
COPY services/tour-worker/src services/tour-worker/src
WORKDIR /app/services/tour-worker
USER node
CMD ["node", "--experimental-strip-types", "src/index.ts"]
