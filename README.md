# BOT THK GraphQL Server

GraphQL backend for BOT THK, with MongoDB persistence, cookie/JWT authentication, GraphQL SSE endpoints, and integrations for email and Cloudinary. The screenshot endpoint is currently not mounted in `src/server.ts`; do not enable it until the SSRF and browser-isolation work is complete.

## Requirements

- Node.js 22 or 24
- Yarn Classic 1.x (the repository is locked with `yarn.lock`)
- MongoDB 8 for local development

## Local setup

```sh
cp .env.example .env
# Generate three independent secrets and copy them into the matching .env entries.
node -e "const c=require('node:crypto'); for (const k of ['ACCESS_TOKEN_SECRET','REFRESH_TOKEN_SECRET','JWT_RESET_PASSWORD']) console.log(k+'='+c.randomBytes(32).toString('base64url'))"
yarn install --frozen-lockfile
yarn test
yarn lint
yarn typecheck
yarn build
```

The example secrets are deliberately rejected by the server. Replace all three with independently generated values before starting it.

### Run and debug locally

Use Docker Compose for MongoDB only, then run the TypeScript server directly on the host:

```sh
docker compose up -d mongo
yarn dev
```

The API listens on `http://127.0.0.1:4001`; check `/healthz` for process liveness and `/readyz` for MongoDB readiness. `yarn dev` uses Node 22's built-in `--watch` mode to restart on imported TypeScript changes; no third-party watcher is needed. For a debugger session, open **Run and Debug** in VS Code and select **Debug BOT THK GraphQL API** (F5); it loads `.env`, stops at startup, and maps breakpoints to TypeScript source. Alternatively, run `yarn debug` to start with the Node inspector on loopback port `9229`, then attach your debugger there. Do not expose the inspector port on a public interface.

For the fully containerized setup, `.env` is required by the server service:

```sh
docker compose up --build
```

The API listens on port `4001`. Compose binds it to `127.0.0.1` on the host. MongoDB is published only on host loopback at `127.0.0.1:27017` for local development (no authentication is configured); do not change this to a public interface or use this setup in production. The `mongo_data` volume survives `docker compose down`; `docker compose down -v` deletes it and all local Mongo data.

Health endpoints are `/healthz` (process liveness) and `/readyz` (MongoDB readiness); GraphQL HTTP is at `/graphql` and SSE is at `/graphql/stream`. Every HTTP response includes an `x-request-id`; Request-scoped logs (including resolver failures) and GraphQL operation logs include that ID; operation logs also include a bounded operation name, duration, query-complexity score, and error count, but never query variables, credentials, or request bodies. Production emits structured JSON logs to stdout; local development uses human-readable Pino output.

For a local server outside Compose, set `MONGODB_URI` to a reachable MongoDB instance, along with independent `ACCESS_TOKEN_SECRET`, `REFRESH_TOKEN_SECRET`, and `JWT_RESET_PASSWORD` values. SendGrid and Cloudinary credentials are optional unless those integrations are used. Never commit `.env` or use the example secrets in a deployed environment.

## Validation

The CI workflow runs frozen dependency installation, ESLint, TypeScript checking, unit tests, TypeScript build, and production Docker image build on Node 22 and 24. Puppeteer browser download is skipped in the image and CI because the screenshot API is not enabled; enabling screenshot capture requires a separate isolated browser-worker deployment and SSRF controls.

## API compatibility note

`resetPassword` now requires the short-lived `token` delivered through the reset email instead of a username. Clients must use the token from `/auth/password/reset/:token`; a username alone can no longer authorize a password change.

## Project and agent-assisted development

This repository is the BOT THK blog backend. The backend migration notes are in [`docs/BACKEND_MIGRATION_PLAN.md`](docs/BACKEND_MIGRATION_PLAN.md). AI coding-agent instructions and the multi-agent development workflow are in [`AGENTS.md`](AGENTS.md) and [`docs/AGENT_WORKFLOW.md`](docs/AGENT_WORKFLOW.md).

Those Markdown files guide development contributors only. They do not add an AI agent runtime, provider, agent tools, or an Agent API to the server.
