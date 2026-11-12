# The Agentome image: the server, the built web app and the `agentome` CLI.
#   docker compose up -d --build      (from a checkout: compose.override.yaml builds it)

# The build runs on the machine's own platform even for an arm64 image: what it produces is
# JavaScript (no dependency of the server has a native addon), so only the last stage runs
# on the target platform and a multi-platform release does not compile under emulation.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo
# The lockfile alone fills the store, so a change to the code downloads nothing again.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch --store-dir=/pnpm
COPY . .
# --ignore-scripts: the root `prepare` installs git hooks, and the context has no .git.
RUN pnpm install --frozen-lockfile --prefer-offline --ignore-scripts --store-dir=/pnpm
RUN pnpm build
# The server with its production dependencies only; the workspace packages come as their
# `files` (dist/, and the migrations of @agentome/db). Not --offline: pnpm checks the
# release age of each package again, and that needs registry metadata the store lacks.
# Then out go the optional peers of better-auth (vitest, react, react-dom, drizzle-kit),
# which the lockfile links because the workspace has them: with vite, esbuild and their
# native binaries, some 90 MB that the server never imports. Source maps and type
# declarations are for tools, not for node.
RUN pnpm --filter @agentome/server deploy --prod --prefer-offline --ignore-scripts \
      --store-dir=/pnpm /out \
 && cd /out/node_modules/.pnpm \
 && rm -rf vitest@* @vitest+* vite@* rolldown@* @rolldown+* esbuild@* @esbuild+* \
      @esbuild-kit+* lightningcss* jsdom@* react@* react-dom@* drizzle-kit@* tsx@* jiti@* \
 && find /out/node_modules -type l ! -exec test -e {} \; -delete \
 && find /out/node_modules -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.cts' \
      -o -name '*.d.mts' \) -delete

# The server seat: the worker with Codex, for agents on the server, and the list of
# what to install for Claude Code, whose license is not open: the pinned version and
# the checksum of each package, from which the seat installs it at its start (seat-start.sh).
#   docker build --target seat -t agentome-seat:local .
# Debian, not Alpine: Claude Code's binary is built for glibc. git for the agent's clone and
# commits; the agent gets no shell unless an admin allowed one, and then this is its toolbox.
FROM node:22-bookworm-slim AS seat
ARG CLAUDE_CODE_VERSION=2.1.280
ARG CODEX_VERSION=0.163.0
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @openai/codex@${CODEX_VERSION} \
 && mkdir -p /usr/local/lib/agentome/claude-code \
 && cd /usr/local/lib/agentome/claude-code \
 && printf '{ "name": "agentome-seat-claude-code", "private": true }\n' > package.json \
 && npm install --package-lock-only --save-exact --no-audit --no-fund \
      @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && npm cache clean --force
COPY --from=build /repo/apps/worker/dist/agentome-worker.mjs /usr/local/lib/agentome/
COPY deploy/seat-start.sh /usr/local/bin/agentome-seat
# The connection and npm's cache are kept in /seat (a volume); the runs, Claude Code and the
# CLI's home are in memory, so a restart leaves nothing of the last run (compose.yaml).
ENV AGENTOME_WORKER_SERVER=1 \
    AGENTOME_WORKER_HOME=/seat \
    HOME=/home/node
# The volume takes the folder's owner when it is first mounted: the worker's.
RUN mkdir /seat && chown node:node /seat
LABEL org.opencontainers.image.source=https://github.com/agentome-ai/agentome
USER node
ENTRYPOINT ["agentome-seat"]
CMD ["run"]

FROM node:22-alpine
# postgresql16-client: pg_dump, pg_restore and psql for `agentome backup` and `restore`, of
# the server's major version. npm, corepack and yarn go: nothing installs packages at run time.
RUN apk add --no-cache postgresql16-client \
 && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
      /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
 && mkdir /data && chown node:node /data
WORKDIR /app
# Root owns the application and the server only reads it; what it writes goes to /data.
COPY --from=build /out/package.json ./
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
COPY --from=build /out/skills ./skills
# The worker as one file, for `curl <server>/connect | sh` (src/connect.ts): no npm on computers.
COPY --from=build /repo/apps/worker/dist/agentome-worker.mjs ./dist/connect/
COPY --from=build /repo/apps/web/dist ./web
# The CLI under the condition the server runs under (see CMD): `agentome reset-password` reads
# the workspace packages, and without it they would resolve to sources the image does not have.
RUN chmod 755 dist/cli.js \
 && printf '#!/bin/sh\nexec node --conditions=agentome-dist /app/dist/cli.js "$@"\n' > /usr/local/bin/agentome \
 && chmod 755 /usr/local/bin/agentome
ENV NODE_ENV=production \
    AGENTOME_LISTEN=0.0.0.0:3000 \
    AGENTOME_DATA_DIR=/data \
    AGENTOME_WEB_DIR=/app/web
# What Admin shows: the release and the commit, given by the release build; without them the
# image is a development build. Last, so that a new commit rebuilds none of the layers above.
ARG AGENTOME_BUILD_VERSION=""
ARG AGENTOME_BUILD_COMMIT=""
ENV AGENTOME_BUILD_VERSION=$AGENTOME_BUILD_VERSION \
    AGENTOME_BUILD_COMMIT=$AGENTOME_BUILD_COMMIT
LABEL org.opencontainers.image.source=https://github.com/agentome-ai/agentome
USER node
VOLUME /data
EXPOSE 3000
# /health answers while the process lives; the migrations of a first start delay it.
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --start-interval=1s \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/health || exit 1
# The workspace packages export their TypeScript sources to the dev tools and their build
# under the condition agentome-dist. A flag, not NODE_OPTIONS, which an operator may set.
CMD ["node", "--conditions=agentome-dist", "dist/main.js"]
