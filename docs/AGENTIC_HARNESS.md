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
        │                                            └── MongoApprovalStore (one-use grant state)
        ├── RunStore
        │     ├── InMemoryRunStore (tests/local only)
        │     └── MongoRunStore (atomic single-document CAS adapter; not integration-tested here)
        └── TraceSink (no-op by default; redacting adapter available)
```

## Guarantees in this prototype

- A run ID is opaque and bounded. A run is associated with both a tenant and a principal; the in-memory and Mongo adapter reads require both scope values. The Mongo adapter also provides an unscoped internal lookup used only for compare-and-swap conflict diagnosis; do not expose it through an API.
- Tool names, descriptions, schemas, permissions, and effect class are declared up front. The registry is sealed when a runtime is constructed. Unknown tools and invalid arguments fail closed.
- JSON inputs are constrained by schema, depth, node count, and supported JSON types. Approval input digests use canonical JSON so object key ordering does not change the digest.
- `PermissionPolicy` requires declared permissions for all tools. `read_only` tools do not require approval. Every `write` tool requires a grant bound to run, tenant, principal, tool, and exact argument digest. `MongoApprovalStore` persists pending/approved/rejected/consumed state, requires a different reviewer from the requester, and atomically consumes the exact grant once.
- If both `CheckpointCipher` and `ApprovalWorkflow` are injected, write actions suspend before execution: the exact tool call and bounded conversation state are encrypted with AES-256-GCM, a durable approval request is created, and the run becomes `waiting_for_approval`. The invocation returns without running the side effect. `AgentApprovalLifecycle` binds approve/reject to the tenant-scoped run and checkpoint, enforces the independent reviewer via the approval store, closes rejected/expired runs, and supports bounded tenant-scoped expiry batches. `resume` revalidates the scoped run, checkpoint, action digest, reviewer decision, expiry, and policy, atomically consumes the approval, clears the checkpoint, and executes only the saved action before asking the provider for its next decision.
- The checkpoint envelope is authenticated to its run ID and stores only ciphertext/IV/tag in the run store. The caller must supply a 32-byte key; key rotation, KMS integration, backup encryption, and operational secret management are not implemented. Losing the key makes pending runs unrecoverable. Approval/checkpoint creation spans two Mongo collections and is deliberately fail-closed rather than transactional; orphan pending requests may require operational cleanup if a crash occurs between writes.
- The runtime enforces hard upper bounds on steps, tool calls, total duration, operation timeout, and output size. Cancellation is propagated with `AbortSignal`; exceptions and trace failures do not disclose raw errors in run events.
- Run events omit task text, model output, tool input, and tool output. The optional trace adapter recursively redacts fields with secret-like names, bounds long values, and handles cycles.
- Golden evaluations operate on deterministic run results and event lists. Tests use scripted model decisions and local tools only; no network or external model is required.

These are code-level prototype guarantees, not a substitute for identity verification at a service boundary, a hardened model provider, resource isolation, or a durable database transaction.

## Local development

The module is exported from `src/agentic/index.ts`. Construct a `ToolRegistry`, register only reviewed tools, create a policy/store/provider, then instantiate `AgentRuntime`. A suspend/resume runtime also needs one shared `ApprovalWorkflow` (used by `PermissionPolicy` and runtime) and an `AesGcmCheckpointCipher` with a securely managed 32-byte key; use `AgentApprovalLifecycle` to coordinate tenant-scoped review decisions and expiry work. Reviewer/tenant identity must come from a trusted authenticated boundary; this module does not provide routes or authentication. See `test/agenticRuntime.spec.ts` and `test/agenticApprovalLifecycle.spec.ts` for deterministic examples. The fake provider consumes a fixed decision script and does not make network calls. `VersionedEvaluationSuite` fixtures can run a bounded number of repeated offline executions, check tool/event/counter/approval expectations, detect nondeterministic outputs, validate redaction, and apply explicit CI thresholds. Suite reports retain case identifiers and safe findings only—not task text, full model output, or exception messages. For persistence adapter development, `createMongoRunCollection(connection)` registers the `AgentRun` schema and `createMongoApprovalCollection(connection)` registers `AgentApproval`; `MongoRunStore` and `MongoApprovalStore` wrap their atomic operations. See the `agenticMongo*Store.spec.ts` tests for offline adapter contracts. These factories do not connect to Mongo or run index migrations.

Run the repository checks:

```sh
yarn typecheck
yarn lint
yarn test
yarn build
```

The Mongo integration test is opt-in and exercises run CAS plus atomic approval consumption. Start the local database (`docker compose up -d mongo`), then run:

```sh
AGENTIC_MONGO_URI='mongodb://127.0.0.1:27017/bot-thk-agentic?directConnection=true' yarn test:agentic:mongo
```

Without `AGENTIC_MONGO_URI`, the opt-in test reports as skipped. The Compose port is bound to loopback and the local database has no authentication; never expose it to a network or reuse it as a production configuration.

Do not register a real side-effect tool for tests that use broad or production credentials. A `read_only` label is a declaration that must be audited against the implementation; the harness cannot prevent a tool from performing a hidden write or network call.

## Prototype limitations and required production work

1. **Durable state and recovery:** a first `MongoRunStore` adapter and strict Mongoose schema now exist. It uses unique run IDs, scoped reads, atomic version/status compare-and-swap updates, monotonic counters, and redacted append-only events. `InMemoryRunStore` remains test/local only. Offline fake-collection and schema/index-definition tests run in the default suite. An opt-in live test is available as `yarn test:agentic:mongo` when `AGENTIC_MONGO_URI` is set, but it was skipped in this environment because Docker is unavailable and no Mongo URI was provided. No live Mongo concurrency, index deployment/migration, crash/restart test, TTL/retention policy, or production wiring has been verified. Add those before production use.
2. **Approval UX and orchestration:** the runtime persists pending decisions, suspends on an encrypted exact-action checkpoint, and resumes after a distinct reviewer approves. `AgentApprovalLifecycle` atomically records approval/rejection/expiry in the approval store and atomically transitions the run with a redacted lifecycle event; a bounded tenant-scoped expiry batch is available to a trusted scheduler. There is still no authenticated approval endpoint, audit UI, rejection notification, scheduler, or restart/worker orchestration. Build those before production; show reviewers a canonical, human-readable action and tool version, and prevent side-effect retries with idempotency keys or an outbox. Cross-collection transactionality and cleanup of orphan requests remain operational concerns.
3. **Provider hardening:** no real provider adapter, prompt governance, token/cost accounting, model output moderation, retry policy, or provider data-retention review is included. Add providers behind the interface only after secret handling, timeout behavior, redaction, and vendor privacy review are approved.
4. **Tool isolation:** the runtime is not a sandbox. Tools execute in-process with application privileges. Any tool that accesses business data must call existing authorized service methods using a trusted principal context; do not pass raw database handles to tools. Add network egress, concurrency, rate, CPU/memory, and per-tool timeout controls at the execution boundary.
5. **API integration and tenant security:** no GraphQL/SSE/HTTP adapter exists. Before exposure, authenticate on every request, derive principal/tenant server-side (never trust caller-supplied scope), authorize run reads/cancellation/approval, add per-tenant quotas and rate limits, and test cross-tenant access and ID enumeration.
6. **Lifecycle correctness:** approval waiting returns `waiting_for_approval`, not success. A caller must later invoke `resume` with the same run, principal, and approval ID. Run-store version compare-and-swap and atomic grant consumption make duplicate resume attempts fail closed; only the first resumed action is executed. Rejection and expiry close waiting runs, and repeated decisions reconcile a prior cross-store partial update. External cancellation while waiting, automated scheduler deployment, crash recovery across the two stores, and idempotency for tools with uncertain completion still need integration testing.
7. **Observability and privacy:** current events are intentionally small and optional. Define retention/deletion, audit access, telemetry cardinality, correlation IDs, metrics, and approved trace fields. Review redaction rules against domain-specific secrets before production.
8. **Evaluation quality:** versioned offline suites now validate fixtures, repeat deterministic cases, compare privacy-safe event/result fingerprints, enforce tool/event/counter/approval assertions, and apply score/failure/stability thresholds. This remains a contract/regression gate, not a quality or safety benchmark for probabilistic models. Add reviewed adversarial prompt-injection cases, model-versioned datasets, repeated provider evaluations, cost/latency measurement, and thresholds before changing a provider or prompt. The runner is provider-neutral and does not connect a model or tool itself; its injected executor must be an isolated fake/local harness.

## Production integration gate

Do not enable a public entry point until all of the following are demonstrated in CI/staging:

- durable concurrent run storage and restart recovery;
- atomic, one-use, auditable approval with exact-action display and idempotent execution;
- authenticated tenant-scoped API operations and cross-tenant negative tests;
- provider timeout/cancellation, secret management, cost/token limits, and data-retention approval;
- reviewed tools calling service-layer authorization, with no generic shell, filesystem, arbitrary HTTP, or direct database access;
- load/concurrency/resource limits, rate limiting, retention/deletion, metrics/alerts, and operational rollback;
- offline deterministic tests plus a separately controlled evaluation suite for the selected real provider.

## Runtime-backed offline evaluation

`evaluationRunner.ts` accepts a provider-neutral executor. `runtimeEvaluationAdapter.ts` now connects that interface to the actual `AgentRuntime` and its scoped `RunStore.get` contract. The adapter does not construct an `AgentRuntime`, discover services, open a database, or choose a provider on its own; callers must inject an evaluation factory. Each executor invocation passes a defensive fixture copy and `{ caseId, repetition }` to that factory, runs the runtime, then retrieves the run snapshot using both the fixture tenant and principal.

The adapter requires the returned run ID, tenant ID, principal ID, terminal/waiting status, step count, tool-call count, output, and all pending-approval claims to agree between the runtime result and persisted snapshot. A missing snapshot or any mismatch is an execution error (never a fabricated successful result). Error messages from the adapter are deliberately generic; underlying factory/runtime/store errors are rethrown only so `runVersionedEvaluationSuite` can turn them into a non-sensitive finding at its report boundary. Returned result and event values are detached copies. Snapshot-only fields such as encrypted checkpoints are not included in suite output.

For ordinary offline regression work, use the isolated factory, which creates a new scripted provider, sealed tool registry, in-memory run store, permission policy, and redacting in-memory trace writer on every repetition:

```ts
import {
    createAgentRuntimeEvaluationExecutor,
    createIsolatedEvaluationFactory,
    runVersionedEvaluationSuite,
} from '../src/agentic'

const factory = createIsolatedEvaluationFactory((_input, context) => ({
    decisions: context.repetition === 0
        ? [{ kind: 'final', output: 'the reviewed fixture result' }]
        : [{ kind: 'final', output: 'the reviewed fixture result' }],
    tools: [],
    clock: () => 1_000,
}))
const execute = createAgentRuntimeEvaluationExecutor(factory)
const report = await runVersionedEvaluationSuite(reviewedSuite, execute)
```

A case that calls a tool should register a local, deterministic stub whose schema, permissions, side-effect declaration, output, and behavior are defined in test code. The harness intentionally has no production service container, Mongo connection, provider client, network transport, or approval workflow. A write tool without an explicitly configured approval workflow fails closed before its `execute` method runs. The utility cannot inspect a tool closure and prove it has no hidden network or business side effects: do not pass production tools, credentials, database handles, or service clients to it. Treat the tool list as executable test code and review it accordingly.

The `IsolatedEvaluationScenarioResolver` is called once per repetition. It may use case IDs and repetition numbers to choose deterministic scripts, but should avoid timestamps, random values, ambient environment, and shared mutable state when the suite asserts determinism. A new factory result means a new provider cursor, tool registry, run map, and trace writer. Use fixture run IDs unique within a suite; a repeated case reuses its fixture ID safely because each repetition gets its own isolated store.

### Contract and integration test coverage

The adapter tests verify invocation identity, scoped reads, rejection of malformed sessions, fail-closed handling of absent and inconsistent snapshots, output/counter/status checks, and exact comparison of all pending approval fields. They also check defensive copies, unusual JSON object keys, omission of encrypted snapshot internals, and propagation of errors for sanitization by the suite runner. A composed test executes a real runtime loop against `ScriptedFakeProvider`, a local read-only fake tool, and `InMemoryRunStore`, then checks repeated deterministic evaluation.

The harness tests cover fresh collaborators per repetition, asynchronous scenario resolution, copied principal values, script validation, malformed/duplicate tools, pure text-only scenarios, bounded tool context, write suspension/failure behavior, trace locality, and script exhaustion. These are in-process tests: they do not establish live Mongo behavior, service/API isolation beyond the construction shown in code, or safety of arbitrary tool implementations. The opt-in live Mongo integration test remains separate and must not be described as passing unless it has actually run against a local Mongo instance.
