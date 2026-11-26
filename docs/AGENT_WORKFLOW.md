# AI coding-agent workflow

## Purpose and boundary

This document describes how AI coding agents (including an orchestrating agent and delegated agents) may collaborate on the BOT THK blog backend. The agents are development contributors: they inspect repository files, propose or implement code changes, run checks, and report results.

This workflow is documentation, not application code. It does not install or execute an agent inside the backend, grant tools access to production data, or create an HTTP/GraphQL endpoint. Agent orchestration, model selection, credentials, and sub-agent invocation belong to the developer's coding-agent product. The repository only defines safe, reviewable collaboration conventions.

## Roles

### Coordinator

One coordinator owns the task outcome. It confirms acceptance criteria, inspects the branch/worktree, breaks work into bounded tasks, declares file ownership, integrates changes, runs final verification, and provides the final handoff. It is the only role that resolves conflicts between contributors or reports the task as complete.

### Implementer

An implementer receives one independently verifiable task, its allowed files, relevant constraints, and expected checks. It reports files changed, decisions made, tests run, and blockers. It must not modify files owned by another active implementer.

### Reviewer

A reviewer independently checks the resulting diff against requirements, security/privacy rules, API/data compatibility, and tests. The reviewer reports findings with file/line references and severity; it should not silently take over implementation. The coordinator routes accepted findings back to the owner and verifies the fix.

For a small change, one agent may perform more than one role in sequence, but implementation and review should be distinct passes. A review pass is not independent if it only repeats the implementer's summary without examining the diff.

## Workflow

### 1. Intake and baseline

1. Read `AGENTS.md`, the relevant implementation, tests, and current task context.
2. Run `git status --short --branch` and inspect existing diffs before editing. Preserve pre-existing work.
3. Restate the user goal as observable acceptance criteria. Identify behavior that must remain unchanged and list explicit non-goals.
4. Identify API/schema, persisted-data, authentication/ownership, privacy, migration, or deployment risks. If a requirement is ambiguous in a way that changes architecture or data exposure, ask before implementing it.
5. Agree on the target branch and validation commands. Do not create parallel work on the same files.

### 2. Plan and delegate

The coordinator writes a short plan that names:

- tasks and their dependencies;
- a single write owner for every file or non-overlapping file group;
- interfaces/files that are shared or must not be changed in parallel;
- acceptance criteria and focused tests per task;
- risks, assumptions, and decisions that require the user's approval.

Parallelize only independent work. Suitable examples include a resolver change and a separate test fixture, or independent docs and code when their paths do not overlap. If tasks touch the same schema, resolver, package manifest, lockfile, or shared type, serialize those edits or assign one owner to integrate them. Do not ask multiple agents to edit a common file and rely on the last write to win.

Use [`AGENT_TASK_TEMPLATE.md`](AGENT_TASK_TEMPLATE.md) to make delegation requests concrete. Delegated agents should return a patch or named changed files, not an unreviewed claim of completion.

### 3. Implement narrowly

- Make the smallest coherent change that satisfies the acceptance criteria.
- Keep GraphQL resolvers/transport handlers consistent with established project patterns.
- Preserve authorization checks and derive ownership from trusted authenticated context.
- Do not add unrelated dependencies, architectural layers, generated files, schema migrations, or new runtime services without explicit scope.
- Add or update tests alongside behavior changes. Prefer deterministic tests that do not contact external services.
- Document migration and rollback behavior whenever persisted data or API contracts change.
- Stop and report if implementation requires a new product decision, a secret, a production credential, or an unreviewed destructive operation.

### 4. Verify

Each implementer runs focused tests for its change and reports exact commands/results. The coordinator then runs the complete relevant checks from `AGENTS.md` against the integrated worktree. A check is successful only if it was actually run and exited successfully. Record skipped checks separately and explain why they were skipped.

For behavior/security changes, the reviewer should look for at least:

- authorization and cross-user/object ownership boundaries;
- accidental field exposure or sensitive logging;
- input validation, error handling, and failure modes;
- API/schema and persisted-data compatibility;
- adequate regression tests, including negative cases;
- unrelated or generated changes in the diff.

### 5. Review, integrate, and hand off

1. The reviewer examines the complete diff, not only the task summary, and returns actionable findings.
2. The coordinator resolves findings with the owning implementer and reruns affected checks.
3. The coordinator checks `git diff --check`, confirms only intended files changed, and summarizes any remaining limitations.
4. Report the final changed files, test commands and outcomes, unrun/skipped validations, and any migration/deployment follow-up. Never imply that CI, live Mongo, Docker, or production behavior passed if only local unit tests ran.

## Shared-workspace coordination rules

- One active writer per file at a time. Announce file ownership before parallel edits.
- Do not reset, clean, checkout, stash, or overwrite another agent's work without explicit coordination.
- If another agent changes an owned file unexpectedly, stop and coordinate rather than force-replacing it.
- Keep shared interfaces small and agree them before implementers work in parallel.
- A merge conflict is a coordination event: the coordinator compares intent and integrates both changes; do not resolve it by deleting one side without review.
- Do not commit, push, merge, or close issues on behalf of a human unless the task or repository operating instructions explicitly authorize that action.

## Scope gate for AI product features

The existence of coding-agent instructions does not imply that the BOT THK backend should run AI agents. Before adding any application-level AI/agent feature, require a separate user-approved product task describing the user problem and desired API. The design must then cover data access, tenant/ownership enforcement, privacy and retention, provider credentials, failure/cost limits, tool permissions, monitoring, and rollback. Until that work is explicitly approved, do not add model providers, agent runtimes, tool execution, agent persistence, or agent-facing GraphQL routes.

## Handoff format

```text
Goal and acceptance criteria:
Implemented files and behavior:
Decisions/assumptions:
Review findings and resolutions:
Checks run (exact commands and outcomes):
Checks skipped or unavailable (and why):
Remaining risks or follow-up:
```
