import assert from 'node:assert/strict'
import test from 'node:test'
import { InMemoryRunStore, RunSnapshot, RunStoreError } from '../src/agentic'

const initialRun = (overrides: Partial<RunSnapshot> = {}): RunSnapshot => ({
    id: 'run-12345678',
    tenantId: 'tenant-a',
    principalId: 'user-1',
    status: 'queued',
    version: 0,
    stepCount: 0,
    toolCallCount: 0,
    createdAt: 100,
    updatedAt: 100,
    events: [],
    ...overrides,
})

test('run store scopes reads by tenant and principal', async () => {
    const store = new InMemoryRunStore()
    await store.create(initialRun())

    assert.equal((await store.get('run-12345678', { tenantId: 'tenant-a', principalId: 'user-1' }))?.status, 'queued')
    assert.equal(await store.get('run-12345678', { tenantId: 'tenant-b', principalId: 'user-1' }), null)
    assert.equal(await store.get('run-12345678', { tenantId: 'tenant-a', principalId: 'user-2' }), null)
})

test('run store enforces unique identifiers and optimistic versions', async () => {
    const store = new InMemoryRunStore()
    await store.create(initialRun())
    await assert.rejects(() => store.create(initialRun()), RunStoreError)

    const updated = await store.transition('run-12345678', 'running', {}, 0)
    assert.equal(updated.version, 1)
    await assert.rejects(
        () => store.appendEvent('run-12345678', { type: 'run_started', at: 101 }, 0),
        /version conflict/
    )
})

test('run store rejects invalid transitions, counter rollback, and terminal mutation', async () => {
    const store = new InMemoryRunStore()
    await store.create(initialRun())
    await assert.rejects(() => store.transition('run-12345678', 'succeeded', {}, 0), /invalid run transition/)

    const running = await store.transition('run-12345678', 'running', { stepCount: 1 }, 0)
    await assert.rejects(
        () => store.transition('run-12345678', 'failed', { stepCount: 0 }, running.version),
        /monotonic/
    )
    const failed = await store.transition('run-12345678', 'failed', { stepCount: 1 }, running.version)
    await assert.rejects(
        () => store.appendEvent('run-12345678', { type: 'run_failed', at: 102 }, failed.version),
        /terminal/
    )
})

test('run store can persist a lifecycle event atomically with its state transition', async () => {
    const store = new InMemoryRunStore(() => 500)
    await store.create(initialRun())
    const running = await store.transition('run-12345678', 'running', {}, 0)
    const cancelled = await store.transition('run-12345678', 'cancelled', {
        event: {
            type: 'approval_rejected',
            at: 499,
            status: 'cancelled',
            detail: { approvalId: 'opaque-approval-reference', token: 'never-persist-this' },
        },
    }, running.version)

    assert.equal(cancelled.version, running.version + 1)
    assert.equal(cancelled.updatedAt, 500)
    assert.equal(cancelled.events.length, 1)
    assert.equal(cancelled.events[0].type, 'approval_rejected')
    assert.equal(cancelled.events[0].detail?.token, '[REDACTED]')
    assert.equal(cancelled.events[0].detail?.approvalId, 'opaque-approval-reference')
})

test('run store returns deeply isolated snapshots and uses the injected clock', async () => {
    let now = 101
    const store = new InMemoryRunStore(() => now)
    await store.create(initialRun())
    const running = await store.transition('run-12345678', 'running', {}, 0)
    const recorded = await store.appendEvent(
        'run-12345678',
        { type: 'tool_call_started', at: 102, detail: { nested: { count: 1 } } },
        running.version
    )
    const returnedNested = recorded.events[0].detail?.nested as { count: number }
    returnedNested.count = 999
    now = 103
    const saved = await store.transition('run-12345678', 'failed', {}, recorded.version)
    const fetched = await store.get('run-12345678', { tenantId: 'tenant-a', principalId: 'user-1' })

    assert.equal(saved.updatedAt, 103)
    assert.equal(fetched?.events[0].detail?.nested && (fetched.events[0].detail.nested as { count: number }).count, 1)
})

test('run store redacts sensitive event details before persistence', async () => {
    const store = new InMemoryRunStore()
    await store.create(initialRun())
    const running = await store.transition('run-12345678', 'running', {}, 0)
    const updated = await store.appendEvent(
        'run-12345678',
        {
            type: 'tool_call_started',
            at: 101,
            toolName: 'lookup_record',
            detail: { token: 'do-not-store', result: 'ok' },
        },
        running.version
    )
    assert.equal(updated.events[0].detail?.token, '[REDACTED]')
    assert.equal(updated.events[0].detail?.result, 'ok')
})
