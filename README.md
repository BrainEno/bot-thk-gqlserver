# BOT THK GraphQL Server

GraphQL backend for BOT THK, with MongoDB persistence, cookie/JWT authentication, GraphQL SSE endpoints, and integrations for email and Cloudinary. The screenshot endpoint is currently not mounted in `src/server.ts`; do not enable it until the SSRF and browser-isolation work is complete.

## Requirements

- Node.js 22 or 24
- Yarn Classic 1.x (the repository is locked with `yarn.lock`)
- MongoDB 8 for local development

## Local setup

```sh
cp .env.example .env
# Replace the three JWT secrets with independent random values.
yarn install --frozen-lockfile
yarn test
yarn lint
yarn typecheck
yarn build
```

For Docker Compose, `.env` is required by the server service:

```sh
docker compose up --build
```

The API listens on port `4001`. Compose binds it to `127.0.0.1` on the host and keeps MongoDB private to the Compose network. Health endpoints are `/healthz` (process liveness) and `/readyz` (MongoDB readiness); GraphQL HTTP is at `/graphql` and SSE is at `/graphql/stream`.

For a local server outside Compose, set `MONGODB_URI` to a reachable MongoDB instance, along with independent `ACCESS_TOKEN_SECRET`, `REFRESH_TOKEN_SECRET`, and `JWT_RESET_PASSWORD` values. SendGrid and Cloudinary credentials are optional unless those integrations are used. Never commit `.env` or use the example secrets in a deployed environment.

## Validation

The CI workflow runs frozen dependency installation, ESLint, TypeScript checking, unit tests, TypeScript build, and production Docker image build on Node 22 and 24. Puppeteer browser download is skipped in the image and CI because the screenshot API is not enabled; enabling screenshot capture requires a separate isolated browser-worker deployment and SSRF controls.

## API compatibility note

`resetPassword` now requires the short-lived `token` delivered through the reset email instead of a username. Clients must use the token from `/auth/password/reset/:token`; a username alone can no longer authorize a password change.

## Migration work

The backend migration and agentic harness architecture are documented in [`docs/MIGRATION_AND_AGENTIC_HARNESS_PLAN.md`](docs/MIGRATION_AND_AGENTIC_HARNESS_PLAN.md). The isolated harness prototype and its production gates are described in [`docs/AGENTIC_HARNESS.md`](docs/AGENTIC_HARNESS.md); repository-specific contributor instructions are in [`AGENTS.md`](AGENTS.md). Security and engineering remediation tracking is in the repository's GitHub issues.
