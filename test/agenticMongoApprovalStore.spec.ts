import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { createConnection } from 'mongoose'
import {
    ApprovalGrant,
    MongoApprovalCollection,
    MongoApprovalFilter,
    MongoApprovalStore,
    MongoApprovalUpdate,
    StoredApproval,
    createMongoApprovalCollection,
} from '../src/agentic'

const tenantId = 'tenant-approval'
const principalId = 'requester-1'
const runId = 'run-approval-001'
const toolName = 'publish_draft'
const inputDigest = 'a'.repeat(64)
const makeGrant = (overrides: Partial<StoredApproval> = {}): StoredApproval => ({
    id: randomUUID(),
    runId,
    principalId,
    tenantId,
    toolName,
    inputDigest,
    expiresAt: 10_000,
    state: 'pending',
    requestedBy: principalId,
    requestedAt: 100,
    ...overrides,
})

test('approval store creates opaque pending requests and scopes reads by tenant', async () => {
    const store = new MongoApprovalStore(new FakeMongoApprovalCollection())
    const record = makeGrant()
    const grant = toGrant(record)
    await store.createPending(grant, record.requestedBy, record.requestedAt)
    assert.equal((await store.get(grant.id, tenantId))?.state, 'pending')
    assert.equal(await store.get(grant.id, 'another-tenant'), null)
    await assert.rejects(() => store.createPending(grant, record.requestedBy, record.requestedAt), /already exists/)
    await assert.rejects(
        () => store.createPending({ ...grant, principalId: 'different-user' }, record.requestedBy, record.requestedAt),
        /invalid/
    )
    await assert.rejects(
        () => store.createPending({ ...grant, id: 'short-id' }, record.requestedBy, record.requestedAt),
        /invalid/
    )
})

test('approval decision is tenant-bound, expires, and requires an independent reviewer', async () => {
    const store = new MongoApprovalStore(new FakeMongoApprovalCollection())
    const record = makeGrant()
    const grant = toGrant(record)
    await store.createPending(grant, record.requestedBy, record.requestedAt)

    assert.equal(await store.approve(grant.id, 'wrong-tenant', 'reviewer-1', 200), false)
    assert.equal(await store.approve(grant.id, tenantId, record.requestedBy, 200), false)
    assert.equal(await store.approve(grant.id, tenantId, 'reviewer-1', grant.expiresAt), false)
    assert.equal(await store.approve(grant.id, tenantId, 'reviewer-1', 200), true)
    assert.equal(await store.approve(grant.id, tenantId, 'reviewer-2', 201), false)

    const approved = await store.get(grant.id, tenantId)
    assert.equal(approved?.state, 'approved')
    assert.equal(approved?.decidedBy, 'reviewer-1')
    assert.equal(approved?.decidedAt, 200)
})

test('approval consumption matches every claim and succeeds atomically once', async () => {
    const store = new MongoApprovalStore(new FakeMongoApprovalCollection())
    const record = makeGrant()
    const grant = toGrant(record)
    await store.createPending(grant, record.requestedBy, record.requestedAt)
    await store.approve(grant.id, tenantId, 'reviewer-1', 200)
    const claims = {
        runId,
        principalId,
        tenantId,
        toolName,
        inputDigest,
        now: 300,
    }

    assert.equal(await store.consume(grant, { ...claims, inputDigest: 'b'.repeat(64) }), false)
    assert.equal(await store.consume({ ...grant, expiresAt: grant.expiresAt + 1 }, claims), false)
    const concurrent = await Promise.all([
        store.consume(grant, claims),
        store.consume(grant, claims),
    ])
    assert.deepEqual(concurrent.sort(), [false, true])
    assert.equal((await store.get(grant.id, tenantId))?.state, 'consumed')
    assert.equal(await store.consume(grant, claims), false)
})

test('rejected and expired requests cannot be consumed', async () => {
    const collection = new FakeMongoApprovalCollection()
    const store = new MongoApprovalStore(collection)
    const rejected = makeGrant()
    const rejectedGrant = toGrant(rejected)
    await store.createPending(rejectedGrant, rejected.requestedBy, rejected.requestedAt)
    assert.equal(await store.reject(rejected.id, tenantId, 'reviewer-1', 200), true)
    assert.equal(await store.consume(rejectedGrant, claimsFor(rejectedGrant, 300)), false)

    const expired = makeGrant({ id: randomUUID(), expiresAt: 400 })
    const expiredGrant = toGrant(expired)
    await store.createPending(expiredGrant, expired.requestedBy, expired.requestedAt)
    assert.equal(await store.approve(expired.id, tenantId, 'reviewer-1', 400), false)
    assert.equal(await store.expire(expired.id, tenantId, 399), false)
    assert.equal(await store.expire(expired.id, tenantId, 400), true)
    assert.equal(await store.expire(expired.id, tenantId, 401), false)
    assert.equal(await store.consume(expiredGrant, claimsFor(expiredGrant, 401)), false)
    const expiredStored = await store.get(expired.id, tenantId)
    assert.equal(expiredStored?.state, 'expired')
    assert.equal(expiredStored?.decidedAt, 400)
})

test('expired approval listing is tenant-scoped, deterministic, pending-only, and bounded', async () => {
    const store = new MongoApprovalStore(new FakeMongoApprovalCollection())
    const first = makeGrant({ expiresAt: 300 })
    const second = makeGrant({ id: randomUUID(), expiresAt: 200 })
    const third = makeGrant({ id: randomUUID(), expiresAt: 120 })
    const otherTenant = makeGrant({ id: randomUUID(), tenantId: 'tenant-other', expiresAt: 150 })
    const decided = makeGrant({ id: randomUUID(), expiresAt: 150 })

    for (const record of [first, second, third, otherTenant, decided]) {
        await store.createPending(toGrant(record), record.requestedBy, record.requestedAt)
    }
    await store.approve(decided.id, tenantId, 'reviewer-1', 120)

    const page = await store.listExpired(tenantId, 300, 2)
    assert.deepEqual(page.map((record) => record.id), [third.id, second.id])
    assert.ok(page.every((record) => record.state === 'pending'))
    assert.deepEqual(await store.listExpired('tenant-other', 300, 10), [await store.get(otherTenant.id, 'tenant-other')])
    assert.deepEqual(await store.listExpired(tenantId, 119, 10), [])
    assert.deepEqual(await store.listExpired(tenantId, 300, 0), [])
    assert.deepEqual(await store.listExpired(tenantId, 300, 101), [])
})

test('Mongoose approval schema defines non-TTL audit indexes', () => {
    const connection = createConnection()
    try {
        createMongoApprovalCollection(connection)
        const model = connection.models.AgentApproval
        assert.ok(model)
        assert.equal(model.collection.collectionName, 'agent_approvals')
        assert.deepEqual(model.schema.path('state')?.options.enum, ['pending', 'approved', 'rejected', 'expired', 'consumed'])
        assert.ok(model.schema.indexes().some(([keys, options]) => keys.id === 1 && options?.unique === true))
        assert.ok(model.schema.indexes().some(([keys]) => keys.tenantId === 1 && keys.runId === 1 && keys.state === 1))
        assert.ok(model.schema.indexes().some(([keys]) =>
            keys.tenantId === 1 && keys.state === 1 && keys.expiresAt === 1 && keys.id === 1
        ))
        assert.ok(model.schema.indexes().some(([keys]) => keys.expiresAt === 1))
        assert.equal(model.schema.indexes().some(([, options]) => Boolean(options?.expireAfterSeconds)), false)
    } finally {
        void connection.close()
    }
})

class FakeMongoApprovalCollection implements MongoApprovalCollection {
    private readonly records = new Map<string, StoredApproval>()

    async insertOne(record: StoredApproval): Promise<void> {
        if (this.records.has(record.id)) throw { code: 11000 }
        this.records.set(record.id, { ...record })
    }

    async findOne(filter: { id: string; tenantId: string }): Promise<StoredApproval | null> {
        const record = this.records.get(filter.id)
        return record?.tenantId === filter.tenantId ? { ...record } : null
    }

    async findOneAndUpdate(filter: MongoApprovalFilter, update: MongoApprovalUpdate): Promise<StoredApproval | null> {
        const record = this.records.get(filter.id)
        if (!record || !matchesFilter(record, filter)) return null
        const next = { ...record, ...update.$set }
        this.records.set(record.id, next)
        return { ...next }
    }

    async listPendingExpired(tenantId: string, now: number, limit: number): Promise<readonly StoredApproval[]> {
        return [...this.records.values()]
            .filter((record) => record.tenantId === tenantId && record.state === 'pending' && record.expiresAt <= now)
            .sort((left, right) => left.expiresAt - right.expiresAt || left.id.localeCompare(right.id))
            .slice(0, limit)
            .map((record) => ({ ...record }))
    }
}

const matchesFilter = (record: StoredApproval, filter: MongoApprovalFilter): boolean => {
    for (const key of ['tenantId', 'runId', 'principalId', 'toolName', 'inputDigest', 'state'] as const) {
        const expected = filter[key]
        if (expected !== undefined && record[key] !== expected) return false
    }
    if (filter.expiresAt !== undefined) {
        if (typeof filter.expiresAt === 'number' && record.expiresAt !== filter.expiresAt) return false
        if (typeof filter.expiresAt === 'object') {
            if ('$gt' in filter.expiresAt && record.expiresAt <= filter.expiresAt.$gt) return false
            if ('$lte' in filter.expiresAt && record.expiresAt > filter.expiresAt.$lte) return false
        }
    }
    if (filter.requestedBy !== undefined) {
        if (typeof filter.requestedBy === 'string' && record.requestedBy !== filter.requestedBy) return false
        if (typeof filter.requestedBy === 'object' && record.requestedBy === filter.requestedBy.$ne) return false
    }
    return true
}

const toGrant = (record: StoredApproval): ApprovalGrant => ({
    id: record.id,
    runId: record.runId,
    principalId: record.principalId,
    tenantId: record.tenantId,
    toolName: record.toolName,
    inputDigest: record.inputDigest,
    expiresAt: record.expiresAt,
})

const claimsFor = (grant: ApprovalGrant, now: number) => ({
    runId: grant.runId,
    principalId: grant.principalId,
    tenantId: grant.tenantId,
    toolName: grant.toolName,
    inputDigest: grant.inputDigest,
    now,
})
