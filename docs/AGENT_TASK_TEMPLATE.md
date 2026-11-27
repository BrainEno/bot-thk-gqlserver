# Agent task: <short action-oriented title>

## Goal
<Describe the user-visible or maintenance outcome.>

## Acceptance criteria
- [ ] <Observable condition, including expected behavior.>
- [ ] <Relevant regression or negative case.>

## Scope
### Allowed files / areas
- `<file or directory>` — <owner agent and responsibility>

### Out of scope
- <Explicitly excluded behavior, APIs, dependencies, or refactors.>

## Coordination
- Coordinator: <name/agent>
- Implementer: <name/agent>
- Reviewer: <name/agent>
- Dependencies/shared interfaces: <none, or describe and agree before parallel work>
- File ownership: <one writer per file; list assignments>

## Constraints and risks
- API/schema or persisted-data compatibility: <requirements>
- Authentication, ownership, and privacy: <requirements>
- External services/secrets: <what must not be used>
- Migration/rollback: <plan or not applicable>

## Validation
- Focused checks: `<commands>`
- Full checks: `yarn typecheck`, `yarn lint`, `yarn test`, `yarn build`, `git diff --check`
- Unavailable/skipped checks to report explicitly: <items>

## Implementer handoff
- Changed files:
- Behavior implemented:
- Tests and exact outcomes:
- Assumptions/blockers:
- Reviewer notes:
