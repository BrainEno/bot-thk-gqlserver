# Instructions for coding agents

## Repository purpose

This is the BOT THK blog backend: a TypeScript, Express, Apollo Server, TypeGraphQL, and MongoDB service. Its application features include authentication, blog/content APIs, social interactions, messaging, GraphQL subscriptions, email, and Cloudinary integration.

Treat this as an application backend, not an agent platform. The `AGENTS.md` and `docs/AGENT_WORKFLOW.md` files are development instructions for coding agents. They do not describe or require an in-process AgentRuntime, LLM provider, autonomous tool executor, or agent-facing API. Do not add those components unless a clearly scoped product requirement is approved.

## Project conventions

- Keep resolvers and transport handlers thin; put reusable business rules at the existing service/domain boundary.
- Preserve GraphQL/API and persisted-data compatibility unless the task explicitly includes a migration.
- Derive identity and tenant/ownership scope from authenticated server context, never from untrusted request arguments.
- Use allowlisted DTOs for public user data. Never expose password material, tokens, private profile data, or internal relationship identifiers unintentionally.
- Keep secrets, cookies, authorization headers, and sensitive request bodies out of logs, traces, and test snapshots.
- Treat external URLs and uploaded content as untrusted. Do not enable screenshot/browser fetching without SSRF controls and process isolation.
- Avoid speculative abstractions and unrelated refactors. Make only the changes needed for the task's acceptance criteria.

## Agent coordination

Follow [`docs/AGENT_WORKFLOW.md`](docs/AGENT_WORKFLOW.md) for task decomposition, file ownership, independent review, verification, and handoff. A coordinator must assign non-overlapping write ownership to parallel implementers. Review agents inspect and report findings rather than silently rewriting another agent's files.

## Required checks

Run the checks relevant to the change before handoff; for application code, run all of these:

```sh
yarn typecheck
yarn lint
yarn test
yarn build
git diff --check
```

- Tests use Node's test runner with `ts-node`; add focused regressions for behavior changes.
- Use deterministic fakes for external services in unit tests. Do not require network access in the default test suite.
- If a check cannot be run, state that explicitly and give the reason. Do not report skipped integration tests as passed.
- For changes to Docker, Compose, Mongo integration, or deployment configuration, report which container/live-service checks were actually executed.

## Change boundaries

- Do not add an LLM SDK, agent runtime, agent-specific persistence, agent tools, or GraphQL agent endpoints as an incidental part of a backend task.
- If a product request explicitly asks for an AI feature, first document the use case, user-facing API, data access rules, privacy/security risks, and operational ownership. Keep that design review separate from the coding-agent workflow in this repository.
- Do not change branches or overwrite unrelated work. Inspect `git status` before editing and preserve existing user changes.
