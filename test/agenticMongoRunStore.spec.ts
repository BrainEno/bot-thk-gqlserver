import assert from 'node:assert/strict'
import test from 'node:test'
import { createConnection } from 'mongoose'
import {
    MongoRunCollection,
    MongoRunFilter,
    MongoRunStore,
    MongoRunUpdate,
    RunSnapshot,
    createMongoRunCollection,
} from '../src/agentic'

const makeRun = (): RunSnapshot => ({
    id: 'run-mongo-123',
    tenantId: 'tenant-a',
    principalId: 'user-1',
    status: 'queued',
    version: 0,
    stepCount: 0,
    toolCallCount: 0,
    createdAt: 100,
    updatedAt: 100,
    events: [],
})

test('Mongo run store creates unique runs and scopes reads to tenant and principal', async () => {
    const store = new MongoRunStore(new FakeMongoCollection())
    await store.create(makeRun())
    assert.equal((await store.get('run-mongo-123', { tenantId: 'tenant-a', principalId: 'user-1' }))?.status, 'queued')
    assert.equal(await store.get('run-mongo-123', { tenantId: 'tenant-b', principalId: 'user-1' }), null)
    assert.equal(await store.get('run-mongo-123', { tenantId: 'tenant-a', principalId: 'other-user' }), null)
    await assert.rejects(() => store.create(makeRun()), /already exists/)
    await assert.rejects(
        () => store.create({ ...makeRun(), events: [{ type: 'run_created', at: 100 }] }),
        /no events/
    )
})

test('Mongo run store persists redacted events with version compare-and-swap', async () => {
    const collection = new FakeMongoCollection()
    const store = new MongoRunStore(collection, () => 101)
    await store.create(makeRun())
    const running = await store.transition('run-mongo-123', 'running', {}, 0)
    const updated = await store.appendEvent(
        'run-mongo-123',
        { type: 'tool_call_started', at: 102, detail: { token: 'secret', nested: { count: 1 } } },
        running.version
    )
    assert.equal(updated.version, 2)
    assert.equal(updated.events[0].detail?.token, '[REDACTED]')
    assert.deepEqual(updated.events[0].detail?.nested, { count: 1 })
    await assert.rejects(
        () => store.appendEvent('run-mongo-123', { type: 'run_started', at: 103 }, 1),
        /version conflict/
    )
})

test('concurrent Mongo event appends with one version have exactly one winner', async () => {
    const store = new MongoRunStore(new FakeMongoCollection())
    await store.create(makeRun())
    const running = await store.transition('run-mongo-123', 'running', {}, 0)
    const outcomes = await Promise.allSettled([
        store.appendEvent('run-mongo-123', { type: 'model_step_started', at: 1, step: 1 }, running.version),
        store.appendEvent('run-mongo-123', { type: 'model_step_started', at: 2, step: 1 }, running.version),
    ])
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1)
    assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1)
    const latest = await store.get('run-mongo-123', { tenantId: 'tenant-a', principalId: 'user-1' })
    assert.equal(latest?.version, 2)
    assert.equal(latest?.events.length, 1)
})

test('Mongo transitions validate state, monotonic counters, and terminal immutability', async () => {
    const store = new MongoRunStore(new FakeMongoCollection())
    await store.create(makeRun())
    await assert.rejects(() => store.transition('run-mongo-123', 'succeeded', {}, 0), /invalid run transition/)
    const running = await store.transition('run-mongo-123', 'running', { stepCount: 1 }, 0)
    await assert.rejects(
        () => store.transition('run-mongo-123', 'failed', { stepCount: 0 }, running.version),
        /monotonic/
    )
    const failed = await store.transition('run-mongo-123', 'failed', { stepCount: 1 }, running.version)
    await assert.rejects(
        () => store.appendEvent('run-mongo-123', { type: 'run_failed', at: 3 }, failed.version),
        /terminal/
    )
})

test('Mongoose run model declares strict run schema and required indexes', () => {
    const connection = createConnection()
    try {
        createMongoRunCollection(connection)
        const model = connection.models.AgentRun
        assert.ok(model)
        assert.equal(model.collection.collectionName, 'agent_runs')
        assert.equal(model.schema.get('strict'), 'throw')
        assert.ok(model.schema.indexes().some(([keys, options]) => keys.id === 1 && options?.unique === true))
        assert.ok(model.schema.indexes().some(([keys]) => keys.tenantId === 1 && keys.principalId === 1))
    } finally {
        void connection.close()
    }
})

class FakeMongoCollection implements MongoRunCollection {
    private readonly records = new Map<string, RunSnapshot>()

    async insertOne(snapshot: RunSnapshot): Promise<void> {
        if (this.records.has(snapshot.id)) throw { code: 11000 }
        this.records.set(snapshot.id, clone(snapshot))
    }

    async findOne(filter: { id: string; tenantId?: string; principalId?: string }): Promise<RunSnapshot | null> {
        const record = this.records.get(filter.id)
        if (!record || (filter.tenantId && record.tenantId !== filter.tenantId) ||
            (filter.principalId && record.principalId !== filter.principalId)) return null
        return clone(record)
    }

    async findOneAndUpdate(filter: MongoRunFilter, update: MongoRunUpdate): Promise<RunSnapshot | null> {
        const current = this.records.get(filter.id)
        if (!current || !matches(current, filter)) return null
        const set = update.$set ?? {}
        const next: RunSnapshot = {
            ...current,
            ...Object.fromEntries(Object.entries(set).filter(([, value]) => value !== null)),
            checkpoint: set.checkpoint === null ? undefined : set.checkpoint ?? current.checkpoint,
            pendingApproval: set.pendingApproval === null ? undefined : set.pendingApproval ?? current.pendingApproval,
            version: current.version + (update.$inc?.version ?? 0),
            events: update.$push ? [...current.events, update.$push.events] : current.events,
        }
        this.records.set(next.id, clone(next))
        return clone(next)
    }
}

const matches = (record: RunSnapshot, filter: MongoRunFilter): boolean => {
    if (filter.version !== undefined && record.version !== filter.version) return false
    if (typeof filter.status === 'string' && record.status !== filter.status) return false
    if (filter.status && typeof filter.status === 'object') {
        if ('$nin' in filter.status && filter.status.$nin.includes(record.status)) return false
        if ('$in' in filter.status && !filter.status.$in.includes(record.status)) return false
    }
    for (const key of ['stepCount', 'toolCallCount'] as const) {
        const expected = filter[key]
        const actual = record[key]
        if (typeof expected === 'number' && actual !== expected) return false
        if (expected && typeof expected === 'object') {
            if (expected.$lte !== undefined && actual > expected.$lte) return false
            if (expected.$gte !== undefined && actual < expected.$gte) return false
        }
    }
    return true
}

const clone = (snapshot: RunSnapshot): RunSnapshot => JSON.parse(JSON.stringify(snapshot)) as RunSnapshot
