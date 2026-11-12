# Contributing

Thank you for wanting to make Agentome better.

## Issues, not pull requests

For now we take **issues** and do not merge pull requests from outside: the code stays with
one copyright holder, which keeps its license simple. A good issue is often worth more than a
patch, and we read every one.

- **A bug:** what you did, what happened, what you expected, the version and how it is
  installed (Docker Compose, from the repository). Logs help: `docker compose logs app`.
- **An idea:** the job you want done and where Agentome stands in the way, more than the
  feature you picture.
- **A security problem:** not an issue; see [SECURITY.md](SECURITY.md).

## Running it from the repository

You need Node 22, pnpm (`corepack enable`) and Docker.

```sh
pnpm install
pnpm --filter @agentome/server dev    # http://localhost:3000, with PostgreSQL 16 running
pnpm --filter @agentome/web dev       # the web app on Vite, passing /api on to the server
pnpm typecheck && pnpm lint && pnpm test
```

The README's Development section has the rest.
