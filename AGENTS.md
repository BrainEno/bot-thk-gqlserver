# Repository agent instructions

## Project shape

- TypeScript backend using Express, Apollo Server, TypeGraphQL, Mongoose/Typegoose, and Yarn Classic.
- Keep resolver/controller work thin. Preserve existing API and persisted-data compatibility unless a migration is explicitly planned.
- `src/agentic/` is an isolated harness package boundary. Do not connect it to GraphQL/HTTP, a real model provider, or production tools without explicit design, authorization, privacy, and operational review.

## Required checks

Run these before handing off changes:

```sh
yarn typecheck
yarn lint
yarn test
yarn build
git -c core.whitespace=cr-at-eol diff --check
```

- Tests use Node's test runner with `ts-node`; add focused regressions for behavior changes.
- Docker is not guaranteed to be installed in the development sandbox. State clearly when image/Compose/Mongo integration was not exercised. The opt-in Mongo persistence test runs with `AGENTIC_MONGO_URI=... yarn test:agentic:mongo`; the repository Compose Mongo port is loopback-only for local development.
- Avoid adding external-network dependencies to unit tests. Use deterministic fakes for provider, database adapter, and services where possible.

## Security and privacy

- Derive identity and tenant scope from authenticated server context, never from untrusted request arguments. Check object ownership and membership at the service boundary.
- Use DTO allowlists for public user data. Do not add credentials, tokens, raw passwords, private profiles, or unbounded prompts/tool payloads to logs, traces, GraphQL responses, or persisted audit events.
- Fail closed on missing authorization, invalid model/tool output, unknown tools, malformed budgets, approval mismatch, and persistence conflicts.
- Treat each tool's `sideEffect` declaration as an auditable contract, not a sandbox. Tools must use existing authorized service methods; do not expose shell, arbitrary URL, filesystem, or raw database capabilities by default.
- Side effects require an explicit idempotency/retry strategy. Never automatically replay a real write after uncertain completion.

## Agentic harness rules

- Preserve the provider/tool/policy/store interfaces and keep vendor SDK types out of the core.
- Register tools before constructing `AgentRuntime`; the runtime seals the registry. Validate tool inputs against bounded schemas and authorize before execution.
- Keep `InMemoryRunStore` test/local only. `MongoRunStore` relies on atomic single-document compare-and-swap updates; deploy indexes deliberately and add real Mongo integration/concurrency tests before production use.
- `MongoApprovalStore` now persists pending/approved/rejected/consumed grant state with atomic one-use consumption; it is not wired to `AgentRuntime` or authenticated endpoints. No approval resume/checkpoint, queue/worker, real provider, or public API is implemented.
- Keep event payloads minimal and redacted. Add tests for cross-tenant isolation, event/version races, cancellation, approval replay, timeouts, and terminal-state rules when changing lifecycle behavior.
- Update `docs/AGENTIC_HARNESS.md` and `docs/MIGRATION_AND_AGENTIC_HARNESS_PLAN.md` whenever harness capabilities, risks, or implementation status change.

## Documentation and changes

- Update relevant docs and this file when architecture, commands, security boundaries, or operational requirements change.
- Keep migrations additive and deployable; document index creation, retention, rollback, and backfill requirements.
- Prefer focused changes with explicit limitations over claiming production readiness based on unit tests alone.
