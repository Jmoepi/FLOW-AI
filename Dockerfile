# syntax=docker/dockerfile:1
# One file, three runtime targets: web, guard, agent. Build one with:
#   docker build --target web   -t flow-ai-web .
#   docker build --target guard -t flow-ai-guard .
#   docker build --target agent -t flow-ai-agent .
# No secret is baked in: no ENV or ARG carries a value, .env* and .secrets are excluded by .dockerignore, and the database
# CA file is mounted at run time. Configuration comes from the host's environment (names are listed in docs/deployment.md).
# The images keep the full workspace install (including dev dependencies) because the workspace packages ship TypeScript
# source and run through tsx; this is simple and reproducible, not size optimised.
FROM node:22-bookworm-slim AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/web/package.json apps/web/
COPY apps/payment-guard/package.json apps/payment-guard/
COPY apps/agent/package.json apps/agent/
COPY packages/contracts/package.json packages/contracts/
COPY packages/database/package.json packages/database/
COPY packages/policy-engine/package.json packages/policy-engine/
COPY packages/xrpl-adapter/package.json packages/xrpl-adapter/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm --filter @flow-ai/web build

# ---- web: public. Next.js server, health at /api/healthz ----
FROM build AS web
ENV NODE_ENV=production
USER node
WORKDIR /app/apps/web
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0"]

# ---- guard: private. Fastify payment service, health at /healthz ----
# Needs GUARD_HOST=0.0.0.0 inside a container, which makes GUARD_BUSINESS_ID mandatory (the guard enforces it).
FROM build AS guard
ENV NODE_ENV=production
USER node
WORKDIR /app/apps/payment-guard
EXPOSE 4002
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.GUARD_PORT||4002)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "--import", "tsx", "src/main.ts"]

# ---- agent: no inbound traffic. Polls the guard; health listener on loopback only ----
FROM build AS agent
ENV NODE_ENV=production
USER node
WORKDIR /app/apps/agent
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://'+(process.env.AGENT_HEALTH_HOST||'127.0.0.1')+':'+(process.env.AGENT_HEALTH_PORT||4003)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "--import", "tsx", "src/main.ts", "--serve"]
