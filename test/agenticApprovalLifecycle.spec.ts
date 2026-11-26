import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import {
    AgentApprovalLifecycle,
    ApprovalGrant,
    InMemoryRunStore,
    RunEvent,
    RunSnapshot,
    RunStore,
    RunStoreError,
} from '../src/agentic'
import { MemoryApprovalWorkflow } from './helpers/memoryApprovalWorkflow'

const owner = { id: 'requester-lifecycle', tenantId: 'tenant-lifecycle', permissions: ['drafts_write'] }
const reviewer = { id: 'reviewer-lifecycle', tenantId: owner.tenantId, permissions: [] }
const runId = 'run-lifecycle-0001'
const nowStart = 10_000
const actionDigest = '9'.repeat(64)

interface Fixture {
    readonly approvalId: string
    readonly grant: ApprovalGrant
    readonly approvals: MemoryApprovalWorkflow
    readonly runs: InMemoryRunStore
    readonly lifecycle: AgentApprovalLifecycle
    readonly currentTime: () => number
    readonly setTime: (value: number) => void
    readonly waitingSnapshot: RunSnapshot
}

const makeFixture = async (options: {
    readonly expiresAt?: number
    readonly approvalId?: string
    readonly checkpoint?: boolean
    readonly actionDigest?: string
} = {}): Promise<Fixture> => {
    let currentTime = nowStart
    const currentTimeFn = () => currentTime
    const setTime = (value: number) => { currentTime = value }
    const approvals = new MemoryApprovalWorkflow()
    const runs = new InMemoryRunStore(currentTimeFn)
    const approvalId = options.approvalId ?? randomUUID()
    const grant: ApprovalGrant = {
        id: approvalId,
        runId,
        principalId: owner.id,
        tenantId: owner.tenantId,
        toolName: 'write_draft',
        inputDigest: options.actionDigest ?? actionDigest,
        expiresAt: options.expiresAt ?? nowStart + 60_000,
    }
    await approvals.createPending(grant, owner.id, nowStart)

    const queued: RunSnapshot = {
        id: runId,
        tenantId: owner.tenantId,
        principalId: owner.id,
        status: 'queued',
        version: 0,
        stepCount: 0,
        toolCallCount: 0,
        createdAt: nowStart,
        updatedAt: nowStart,
        events: [],
    }
    await runs.create(queued)
    const running = await runs.transition(runId, 'running', {
        stepCount: 1,
        toolCallCount: 1,
    }, 0)
    const waitingSnapshot = await runs.transition(runId, 'waiting_for_approval', {
        checkpoint: options.checkpoint === false ? null : {
            version: 1,
            algorithm: 'aes-256-gcm',
            iv: 'AA',
            authTag: 'AA',
            ciphertext: 'AA',
        },
        pendingApproval: {
            id: approvalId,
            toolName: grant.toolName,
            inputDigest: grant.inputDigest,
            expiresAt: grant.expiresAt,
        },
    }, running.version)
    const lifecycle = new AgentApprovalLifecycle(approvals, runs, currentTimeFn)
    return { approvalId, grant, approvals, runs, lifecycle, currentTime: currentTimeFn, setTime, waitingSnapshot }
}

const reviewInput = (fixture: Fixture, overrides: Partial<{
    approvalId: string
    runId: string
    tenantId: string
    reviewerId: string
}> = {}) => ({
    approvalId: fixture.approvalId,
    runId,
    tenantId: owner.tenantId,
    reviewerId: reviewer.id,
    ...overrides,
})

const readRun = (fixture: Fixture) => fixture.runs.get(runId, {
    tenantId: owner.tenantId,
    principalId: owner.id,
})

const assertClear = (snapshot: RunSnapshot | null): void => {
    assert.equal(snapshot?.checkpoint, undefined)
    assert.equal(snapshot?.pendingApproval, undefined)
}

test('approval lifecycle records independent approval and leaves the run ready to resume', async () => {
    const fixture = await makeFixture()
    const outcome = await fixture.lifecycle.approve(reviewInput(fixture))
    const approval = await fixture.approvals.get(fixture.approvalId, owner.tenantId)
    const snapshot = await readRun(fixture)

    assert.equal(outcome.outcome, 'approved')
    assert.equal(outcome.runStatus, 'waiting_for_approval')
    assert.equal(approval?.state, 'approved')
    assert.equal(approval?.requestedBy, owner.id)
    assert.equal(approval?.decidedBy, reviewer.id)
    assert.equal(snapshot?.status, 'waiting_for_approval')
    assert.ok(snapshot?.checkpoint)
    assert.equal(snapshot?.pendingApproval?.id, fixture.approvalId)
})

test('approval lifecycle rejects an action, atomically closes the run, and clears sensitive continuation', async () => {
    const fixture = await makeFixture()
    const outcome = await fixture.lifecycle.reject(reviewInput(fixture))
    const snapshot = await readRun(fixture)
    const approval = await fixture.approvals.get(fixture.approvalId, owner.tenantId)
    const event = snapshot?.events.at(-1)

    assert.equal(outcome.outcome, 'rejected')
    assert.equal(outcome.runStatus, 'cancelled')
    assert.equal(approval?.state, 'rejected')
    assert.equal(approval?.decidedBy, reviewer.id)
    assert.equal(snapshot?.status, 'cancelled')
    assertClear(snapshot)
    assert.equal(event?.type, 'approval_rejected')
    assert.equal(event?.status, 'cancelled')
    assert.deepEqual(event?.detail, { approvalId: fixture.approvalId })
    assert.equal(snapshot?.version, fixture.waitingSnapshot.version + 1)
})

test('approval expiry is not actionable before its exact deadline', async () => {
    const fixture = await makeFixture({ expiresAt: nowStart + 500 })
    fixture.setTime(nowStart + 499)
    const outcome = await fixture.lifecycle.expire({
        approvalId: fixture.approvalId,
        runId,
        tenantId: owner.tenantId,
    })

    assert.equal(outcome.outcome, 'not_due')
    assert.equal((await fixture.approvals.get(fixture.approvalId, owner.tenantId))?.state, 'pending')
    assert.equal((await readRun(fixture))?.status, 'waiting_for_approval')
})

test('approval expiry at the deadline closes the run as failed and records a safe event', async () => {
    const fixture = await makeFixture({ expiresAt: nowStart + 500 })
    fixture.setTime(nowStart + 500)
    const outcome = await fixture.lifecycle.expire({
        approvalId: fixture.approvalId,
        runId,
        tenantId: owner.tenantId,
    })
    const snapshot = await readRun(fixture)

    assert.equal(outcome.outcome, 'expired')
    assert.equal(outcome.runStatus, 'failed')
    assert.equal((await fixture.approvals.get(fixture.approvalId, owner.tenantId))?.state, 'expired')
    assert.equal(snapshot?.status, 'failed')
    assertClear(snapshot)
    assert.equal(snapshot?.events.at(-1)?.type, 'approval_expired')
    assert.equal(snapshot?.events.at(-1)?.status, 'failed')
    assert.deepEqual(snapshot?.events.at(-1)?.detail, { approvalId: fixture.approvalId })
})

test('bounded expiry batches close each overdue run and become empty after one pass', async () => {
    const fixture = await makeFixture({ expiresAt: nowStart + 5 })
    fixture.setTime(nowStart + 5)
    const batch = await fixture.lifecycle.expireBatch({ tenantId: owner.tenantId, limit: 10 })
    const repeated = await fixture.lifecycle.expireBatch({ tenantId: owner.tenantId, limit: 10 })

    assert.equal(batch.scanned, 1)
    assert.equal(batch.expired, 1)
    assert.equal(batch.stale, 0)
    assert.equal(batch.invalidRequest, false)
    assert.equal(batch.outcomes[0].runStatus, 'failed')
    assert.equal(repeated.scanned, 0)
    assert.equal(repeated.expired, 0)
    assert.equal((await readRun(fixture))?.status, 'failed')
})

test('expiry batch rejects invalid tenant identities and unbounded page sizes', async () => {
    const fixture = await makeFixture({ expiresAt: nowStart + 1 })
    fixture.setTime(nowStart + 1)
    const invalidTenant = await fixture.lifecycle.expireBatch({ tenantId: ' ', limit: 10 })
    const zeroLimit = await fixture.lifecycle.expireBatch({ tenantId: owner.tenantId, limit: 0 })
    const excessiveLimit = await fixture.lifecycle.expireBatch({ tenantId: owner.tenantId, limit: 101 })

    for (const result of [invalidTenant, zeroLimit, excessiveLimit]) {
        assert.equal(result.invalidRequest, true)
        assert.equal(result.scanned, 0)
        assert.deepEqual(result.outcomes, [])
    }
    assert.equal((await fixture.approvals.get(fixture.approvalId, owner.tenantId))?.state, 'pending')
})

test('late review expires the request instead of accepting an overdue decision', async () => {
    const fixture = await makeFixture({ expiresAt: nowStart + 5 })
    fixture.setTime(nowStart + 5)
    const outcome = await fixture.lifecycle.approve(reviewInput(fixture))

    assert.equal(outcome.outcome, 'expired')
    assert.equal((await fixture.approvals.get(fixture.approvalId, owner.tenantId))?.state, 'expired')
    assert.equal((await readRun(fixture))?.status, 'failed')
})

test('requesters cannot review their own pending actions', async () => {
    const fixture = await makeFixture()
    const outcome = await fixture.lifecycle.approve(reviewInput(fixture, { reviewerId: owner.id }))

    assert.equal(outcome.outcome, 'not_authorized')
    assert.equal((await fixture.approvals.get(fixture.approvalId, owner.tenantId))?.state, 'pending')
    assert.equal((await readRun(fixture))?.status, 'waiting_for_approval')
})

test('review lookup does not disclose approvals across tenant or run boundaries', async () => {
    const fixture = await makeFixture()
    const wrongTenant = await fixture.lifecycle.approve(reviewInput(fixture, { tenantId: 'tenant-other' }))
    const wrongRun = await fixture.lifecycle.reject(reviewInput(fixture, { runId: 'run-another-0001' }))

    assert.equal(wrongTenant.outcome, 'not_found')
    assert.equal(wrongRun.outcome, 'not_found')
    assert.equal((await fixture.approvals.get(fixture.approvalId, owner.tenantId))?.state, 'pending')
    assert.equal((await readRun(fixture))?.status, 'waiting_for_approval')
})

test('expiry rejects malformed IDs and non-finite worker clock values', async () => {
    const fixture = await makeFixture()
    const malformed = await fixture.lifecycle.expire({
        approvalId: 'short',
        runId,
        tenantId: owner.tenantId,
    })
    fixture.setTime(Number.NaN)
    const invalidClock = await fixture.lifecycle.expire({
        approvalId: fixture.approvalId,
        runId,
        tenantId: owner.tenantId,
    })

    assert.equal(malformed.outcome, 'invalid_request')
    assert.equal(invalidClock.outcome, 'stale')
    assert.equal((await fixture.approvals.get(fixture.approvalId, owner.tenantId))?.state, 'pending')
})

test('approval actions fail stale when the run checkpoint no longer matches the audit record', async () => {
    const fixture = await makeFixture({ actionDigest: '8'.repeat(64) })
    const run = await readRun(fixture)
    assert.ok(run)
    const altered = await fixture.runs.transition(runId, 'failed', {
        checkpoint: null,
        pendingApproval: null,
    }, run.version)
    assert.equal(altered.status, 'failed')
    const outcome = await fixture.lifecycle.reject(reviewInput(fixture))

    assert.equal(outcome.outcome, 'stale')
    assert.equal((await fixture.approvals.get(fixture.approvalId, owner.tenantId))?.state, 'pending')
})

test('review refuses a durable approval record whose run checkpoint is missing', async () => {
    const fixture = await makeFixture({ checkpoint: false })
    const outcome = await fixture.lifecycle.approve(reviewInput(fixture))

    assert.equal(outcome.outcome, 'stale')
    assert.equal((await fixture.approvals.get(fixture.approvalId, owner.tenantId))?.state, 'pending')
    assert.equal((await readRun(fixture))?.status, 'waiting_for_approval')
})

test('expiry never overwrites a run already closed by another authorized lifecycle action', async () => {
    const fixture = await makeFixture({ expiresAt: nowStart + 10 })
    fixture.setTime(nowStart + 10)
    const waiting = await readRun(fixture)
    assert.ok(waiting)
    await fixture.runs.transition(runId, 'cancelled', {
        checkpoint: null,
        pendingApproval: null,
    }, waiting.version)

    const outcome = await fixture.lifecycle.expire({
        approvalId: fixture.approvalId,
        runId,
        tenantId: owner.tenantId,
    })
    const snapshot = await readRun(fixture)
    assert.equal(outcome.outcome, 'expired')
    assert.equal(outcome.runStatus, 'cancelled')
    assert.equal(snapshot?.status, 'cancelled')
    assert.equal(snapshot?.events.filter((event) => event.type === 'approval_expired').length, 0)
})

test('approval expiry remains retryable when the run adapter reports a CAS conflict', async () => {
    const fixture = await makeFixture({ expiresAt: nowStart + 20 })
    fixture.setTime(nowStart + 20)
    const conflictRuns = new ConflictOnceRunStore(fixture.runs)
    const lifecycle = new AgentApprovalLifecycle(fixture.approvals, conflictRuns, fixture.currentTime)
    const outcome = await lifecycle.expire({
        approvalId: fixture.approvalId,
        runId,
        tenantId: owner.tenantId,
    })
    const snapshot = await readRun(fixture)

    assert.equal(outcome.outcome, 'expired')
    assert.equal(conflictRuns.conflicts, 1)
    assert.equal(snapshot?.status, 'failed')
    assert.equal(snapshot?.events.filter((event) => event.type === 'approval_expired').length, 1)
})

test('approval lifecycle repairs a rejected decision whose run close was interrupted', async () => {
    const fixture = await makeFixture()
    assert.equal(await fixture.approvals.reject(fixture.approvalId, owner.tenantId, reviewer.id, nowStart + 1), true)
    assert.equal((await readRun(fixture))?.status, 'waiting_for_approval')

    const outcome = await fixture.lifecycle.reject(reviewInput(fixture))
    const snapshot = await readRun(fixture)
    assert.equal(outcome.outcome, 'rejected')
    assert.equal(snapshot?.status, 'cancelled')
    assert.equal(snapshot?.events.filter((event) => event.type === 'approval_rejected').length, 1)
})

test('approval lifecycle repairs an expired decision whose run close was interrupted', async () => {
    const fixture = await makeFixture({ expiresAt: nowStart + 2 })
    fixture.setTime(nowStart + 2)
    assert.equal(await fixture.approvals.expire(fixture.approvalId, owner.tenantId, fixture.currentTime()), true)
    assert.equal((await readRun(fixture))?.status, 'waiting_for_approval')

    const outcome = await fixture.lifecycle.expire({
        approvalId: fixture.approvalId,
        runId,
        tenantId: owner.tenantId,
    })
    const snapshot = await readRun(fixture)
    assert.equal(outcome.outcome, 'expired')
    assert.equal(snapshot?.status, 'failed')
    assert.equal(snapshot?.events.filter((event) => event.type === 'approval_expired').length, 1)
})

test('duplicate rejection requests are idempotent and persist one lifecycle event', async () => {
    const fixture = await makeFixture()
    const outcomes = await Promise.all([
        fixture.lifecycle.reject(reviewInput(fixture)),
        fixture.lifecycle.reject(reviewInput(fixture)),
        fixture.lifecycle.reject(reviewInput(fixture)),
    ])
    const snapshot = await readRun(fixture)

    assert.ok(outcomes.every((outcome) => outcome.outcome === 'rejected'))
    assert.equal(snapshot?.status, 'cancelled')
    assert.equal(snapshot?.events.filter((event) => event.type === 'approval_rejected').length, 1)
})

test('approval and rejection races produce one durable decision', async () => {
    const fixture = await makeFixture()
    const outcomes = await Promise.all([
        fixture.lifecycle.approve(reviewInput(fixture)),
        fixture.lifecycle.reject(reviewInput(fixture)),
    ])
    const state = (await fixture.approvals.get(fixture.approvalId, owner.tenantId))?.state
    const snapshot = await readRun(fixture)

    assert.ok(state === 'approved' || state === 'rejected')
    assert.equal(Number(state === 'approved') + Number(state === 'rejected'), 1)
    assert.ok(outcomes.some((outcome) => outcome.outcome === state))
    if (state === 'approved') {
        assert.equal(snapshot?.status, 'waiting_for_approval')
        assert.equal(snapshot?.events.filter((event) => event.type === 'approval_rejected').length, 0)
    } else {
        assert.equal(snapshot?.status, 'cancelled')
        assert.equal(snapshot?.events.filter((event) => event.type === 'approval_rejected').length, 1)
    }
})

test('expiry and approval race cannot create an approved expired request', async () => {
    const fixture = await makeFixture({ expiresAt: nowStart + 100 })
    fixture.setTime(nowStart + 100)
    const [review, expiry] = await Promise.all([
        fixture.lifecycle.approve(reviewInput(fixture)),
        fixture.lifecycle.expire({ approvalId: fixture.approvalId, runId, tenantId: owner.tenantId }),
    ])
    const record = await fixture.approvals.get(fixture.approvalId, owner.tenantId)
    const snapshot = await readRun(fixture)

    assert.equal(record?.state, 'expired')
    assert.equal(review.outcome, 'expired')
    assert.equal(expiry.outcome, 'expired')
    assert.equal(snapshot?.status, 'failed')
    assert.equal(snapshot?.events.filter((event) => event.type === 'approval_expired').length, 1)
})

test('already approved requests cannot be changed to rejection', async () => {
    const fixture = await makeFixture()
    assert.equal(await fixture.approvals.approve(fixture.approvalId, owner.tenantId, reviewer.id, nowStart + 1), true)
    const outcome = await fixture.lifecycle.reject(reviewInput(fixture))

    assert.equal(outcome.outcome, 'already_decided')
    assert.equal((await fixture.approvals.get(fixture.approvalId, owner.tenantId))?.state, 'approved')
    assert.equal((await readRun(fixture))?.status, 'waiting_for_approval')
})

test('invalid review identifiers are rejected before touching storage', async () => {
    const fixture = await makeFixture()
    const outcome = await fixture.lifecycle.approve(reviewInput(fixture, {
        approvalId: 'not-an-opaque-approval-id',
        reviewerId: ' ',
    }))

    assert.equal(outcome.outcome, 'invalid_request')
    assert.equal(outcome.approvalId, 'not-an-opaque-approval-id')
    assert.equal((await fixture.approvals.get(fixture.approvalId, owner.tenantId))?.state, 'pending')
})

test('lifecycle rechecks the run after a compare-and-swap conflict', async () => {
    const fixture = await makeFixture()
    const conflictRuns = new ConflictOnceRunStore(fixture.runs)
    const lifecycle = new AgentApprovalLifecycle(fixture.approvals, conflictRuns, fixture.currentTime)
    const outcome = await lifecycle.reject(reviewInput(fixture))
    const snapshot = await readRun(fixture)

    assert.equal(outcome.outcome, 'rejected')
    assert.equal(conflictRuns.conflicts, 1)
    assert.equal(snapshot?.status, 'cancelled')
    assert.equal(snapshot?.events.filter((event) => event.type === 'approval_rejected').length, 1)
    assert.equal(snapshot?.events.some((event) => event.type === 'model_step_started'), true)
})

class ConflictOnceRunStore implements RunStore {
    conflicts = 0

    constructor(private readonly delegate: InMemoryRunStore) {}

    create(snapshot: RunSnapshot): Promise<void> {
        return this.delegate.create(snapshot)
    }

    get(id: string, scope: { tenantId: string; principalId: string }): Promise<RunSnapshot | null> {
        return this.delegate.get(id, scope)
    }

    appendEvent(id: string, event: RunEvent, expectedVersion: number): Promise<RunSnapshot> {
        return this.delegate.appendEvent(id, event, expectedVersion)
    }

    async transition(
        id: string,
        next: RunSnapshot['status'],
        patch: Parameters<RunStore['transition']>[2],
        expectedVersion: number
    ): Promise<RunSnapshot> {
        if (this.conflicts === 0) {
            this.conflicts += 1
            await this.delegate.appendEvent(id, {
                type: 'model_step_started',
                at: nowStart + 2,
                step: 1,
            }, expectedVersion)
        }
        try {
            return await this.delegate.transition(id, next, patch, expectedVersion)
        } catch (error) {
            if (error instanceof RunStoreError) throw error
            throw error
        }
    }
}
