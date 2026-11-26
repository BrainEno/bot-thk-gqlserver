# Agentic Harness: isolated execution core

**Status:** deterministic, in-process prototype. It is not connected to GraphQL, HTTP, a real model, MongoDB, queues, or production business tools. Keep it unreachable from public routes until the deployment gates below are implemented.

The harness separates model decisions from tools and makes the authorization boundary explicit:

```text
caller identity + bounded task
        │
        ▼
AgentRuntime ── ModelProvider (interface; ScriptedFakeProvider for tests)
        │
        ├── ToolRegistry ── JSON Schema validation ── AgentPolicy
        │                                            └── one-use approval verifier
        ├── RunStore
        │     ├── InMemoryRunStore (tests/local only)
        │     └── MongoRunStore (atomic single-document CAS adapter; not integration-tested here)
        └── TraceSink (no-op by default; redacting adapter available)
```

## Guarantees in this prototype

- A run ID is opaque and bounded. A run is associated with both a tenant and a principal; the in-memory and Mongo adapter reads require both scope values. The Mongo adapter also provides an unscoped internal lookup used only for compare-and-swap conflict diagnosis; do not expose it through an API.
- Tool names, descriptions, schemas, permissions, and effect class are declared up front. The registry is sealed when a runtime is constructed. Unknown tools and invalid arguments fail closed.
- JSON inputs are constrained by schema, depth, node count, and supported JSON types. Approval input digests use canonical JSON so object key ordering does not change the digest.
- `PermissionPolicy` requires declared permissions for all tools. `read_only` tools do not require approval. Every `write` tool requires a grant bound to run, tenant, principal, tool, and exact argument digest; an `ApprovalVerifier` is responsible for atomic one-use consumption.
- The runtime enforces hard upper bounds on steps, tool calls, total duration, operation timeout, and output size. Cancellation is propagated with `AbortSignal`; exceptions and trace failures do not disclose raw errors in run events.
- Run events omit task text, model output, tool input, and tool output. The optional trace adapter recursively redacts fields with secret-like names, bounds long values, and handles cycles.
- Golden evaluations operate on deterministic run results and event lists. Tests use scripted model decisions and local tools only; no network or external model is required.

These are code-level prototype guarantees, not a substitute for identity verification at a service boundary, a hardened model provider, resource isolation, or a durable database transaction.

## Local development

The module is exported from `src/agentic/index.ts`. Construct a `ToolRegistry`, register only reviewed tools, create a policy/store/provider, then instantiate `AgentRuntime`. See `test/agenticRuntime.spec.ts` for complete examples. The fake provider consumes a fixed decision script and does not make network calls. For persistence adapter development, `createMongoRunCollection(connection)` registers the `AgentRun` Mongoose schema and `MongoRunStore` wraps its CAS operations; see `test/agenticMongoRunStore.spec.ts` for offline adapter-contract tests. This factory does not connect to Mongo or run index migrations.

Run the repository checks:

```sh
yarn typecheck
yarn lint
yarn test
yarn build
```

The Mongo integration test is opt-in. Start the local database (`docker compose up -d mongo`), then run:

```sh
AGENTIC_MONGO_URI='mongodb://127.0.0.1:27017/bot-thk-agentic?directConnection=true' yarn test:agentic:mongo
```

Without `AGENTIC_MONGO_URI`, the opt-in test reports as skipped. The Compose port is bound to loopback and the local database has no authentication; never expose it to a network or reuse it as a production configuration.

Do not register a real side-effect tool for tests that use broad or production credentials. A `read_only` label is a declaration that must be audited against the implementation; the harness cannot prevent a tool from performing a hidden write or network call.

## Prototype limitations and required production work

1. **Durable state and recovery:** a first `MongoRunStore` adapter and strict Mongoose schema now exist. It uses unique run IDs, scoped reads, atomic version/status compare-and-swap updates, monotonic counters, and redacted append-only events. `InMemoryRunStore` remains test/local only. Offline fake-collection and schema/index-definition tests run in the default suite. An opt-in live test is available as `yarn test:agentic:mongo` when `AGENTIC_MONGO_URI` is set, but it was skipped in this environment because Docker is unavailable and no Mongo URI was provided. No live Mongo concurrency, index deployment/migration, crash/restart test, TTL/retention policy, or production wiring has been verified. Add those before production use.
2. **Approval UX and atomicity:** no approval endpoint, pending-action checkpoint/resume flow, or production verifier exists. Implement a transactional one-use grant consume operation and bind approval to a human actor, exact displayed arguments, expiry, tenant, run, tool version, and digest. Ensure retries cannot repeat an external side effect; use idempotency keys or an outbox.
3. **Provider hardening:** no real provider adapter, prompt governance, token/cost accounting, model output moderation, retry policy, or provider data-retention review is included. Add providers behind the interface only after secret handling, timeout behavior, redaction, and vendor privacy review are approved.
4. **Tool isolation:** the runtime is not a sandbox. Tools execute in-process with application privileges. Any tool that accesses business data must call existing authorized service methods using a trusted principal context; do not pass raw database handles to tools. Add network egress, concurrency, rate, CPU/memory, and per-tool timeout controls at the execution boundary.
5. **API integration and tenant security:** no GraphQL/SSE/HTTP adapter exists. Before exposure, authenticate on every request, derive principal/tenant server-side (never trust caller-supplied scope), authorize run reads/cancellation/approval, add per-tenant quotas and rate limits, and test cross-tenant access and ID enumeration.
6. **Lifecycle correctness:** approval waiting currently ends the invocation with a `waiting_for_approval` result; this in-memory prototype does not persist enough checkpoint data to resume the exact decision. Do not treat waiting as a completed durable workflow. Add explicit suspend/resume, cancellation from a separate worker, expiry, and race tests.
7. **Observability and privacy:** current events are intentionally small and optional. Define retention/deletion, audit access, telemetry cardinality, correlation IDs, metrics, and approved trace fields. Review redaction rules against domain-specific secrets before production.
8. **Evaluation quality:** golden evaluation is a small deterministic contract, not a quality or safety benchmark for probabilistic models. Add versioned fixtures, adversarial prompt-injection cases, tool-policy regression sets, repeated model evaluations, and explicit quality/cost/latency thresholds before changing a provider or prompt.

## Production integration gate

Do not enable a public entry point until all of the following are demonstrated in CI/staging:

- durable concurrent run storage and restart recovery;
- atomic, one-use, auditable approval with exact-action display and idempotent execution;
- authenticated tenant-scoped API operations and cross-tenant negative tests;
- provider timeout/cancellation, secret management, cost/token limits, and data-retention approval;
- reviewed tools calling service-layer authorization, with no generic shell, filesystem, arbitrary HTTP, or direct database access;
- load/concurrency/resource limits, rate limiting, retention/deletion, metrics/alerts, and operational rollback;
- offline deterministic tests plus a separately controlled evaluation suite for the selected real provider.
