# One image for every Node service (ingestion API, worker, dashboard API, loadgen,
# migrations). Each container picks what to run with its command; see
# docker-compose.yml. One image means one build, and every service always runs
# the same version of the shared schemas.
FROM node:24-slim

WORKDIR /app

# Dependencies first, in their own layer: it's rebuilt only when a package.json
# or the lockfile changes, not on every code change.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/api/package.json packages/api/
COPY packages/worker/package.json packages/worker/
COPY packages/dashboard-api/package.json packages/dashboard-api/
COPY packages/dashboard/package.json packages/dashboard/
COPY packages/loadgen/package.json packages/loadgen/
RUN npm ci --no-audit --no-fund

COPY . .
# The React app is built to static files once, here. The dashboard API serves them.
RUN npm run build -w @bloxlytics/dashboard

ENV NODE_ENV=production \
    API_HOST=0.0.0.0 \
    DASHBOARD_API_HOST=0.0.0.0 \
    DASHBOARD_STATIC_DIR=/app/packages/dashboard/dist

# Don't run as root inside the container.
USER node

# TypeScript runs through tsx, loaded into node (no separate compile step).
# node itself is PID 1, so SIGTERM from `docker stop` reaches our shutdown
# handlers directly instead of stopping at an npx wrapper. Overridden per service.
CMD ["node", "--import", "tsx", "packages/api/src/main.ts"]
