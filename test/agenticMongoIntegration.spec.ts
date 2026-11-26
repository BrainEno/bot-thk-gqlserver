import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { createConnection } from 'mongoose'
import {
    ApprovalGrant,
    createMongoApprovalCollection,
    createMongoRunCollection,
    MongoApprovalStore,
    MongoRunStore,
    RunSnapshot,
} from '../src/agentic'

const mongoUri = process.env.AGENTIC_MONGO_URI

test(
    'Mongo stores persist scoped runs and atomically consume approved grants once',
    { skip: mongoUri ? false : 'set AGENTIC_MONGO_URI to run the local Mongo integration test' },
    async () => {
        const connection = await createConnection(mongoUri as string, {
            serverSelectionTimeoutMS: 5000,
            connectTimeoutMS: 5000,
        }).asPromise()
        const runId = `run-${randomUUID()}`
        const principal = { tenantId: 'integration-tenant', principalId: 'integration-user' }
        const snapshot: RunSnapshot = {
            id: runId,
            tenantId: principal.tenantId,
            principalId: principal.principalId,
            status: 'queued',
            version: 0,
            stepCount: 0,
            toolCallCount: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            events: [],
        }
        const collection = createMongoRunCollection(connection)
        const model = connection.models.AgentRun
        const approvalCollection = createMongoApprovalCollection(connection)
        const approvalModel = connection.models.AgentApproval
        const approvalStore = new MongoApprovalStore(approvalCollection)
        const approvalId = randomUUID()
        const store = new MongoRunStore(collection)

        try {
            await model.init()
            await approvalModel.init()
            await store.create(snapshot)
            assert.equal((await store.get(runId, principal))?.status, 'queued')
            assert.equal(
                await store.get(runId, { ...principal, tenantId: 'another-tenant' }),
                null
            )

            const running = await store.transition(runId, 'running', { stepCount: 1 }, 0)
            const firstEvent = await store.appendEvent(
                runId,
                {
                    type: 'tool_call_started',
                    at: Date.now(),
                    detail: { authorization: 'never-persist-this', count: 1 },
                },
                running.version
            )
            assert.equal(firstEvent.events[0].detail?.authorization, '[REDACTED]')

            const concurrent = await Promise.allSettled([
                store.appendEvent(runId, { type: 'model_step_started', at: Date.now(), step: 2 }, firstEvent.version),
                store.appendEvent(runId, { type: 'model_step_started', at: Date.now(), step: 2 }, firstEvent.version),
            ])
            assert.equal(concurrent.filter((result) => result.status === 'fulfilled').length, 1)
            assert.equal(concurrent.filter((result) => result.status === 'rejected').length, 1)

            const persisted = await store.get(runId, principal)
            assert.equal(persisted?.events.length, 2)
            assert.equal(persisted?.version, firstEvent.version + 1)
            await store.transition(runId, 'failed', { stepCount: 2 }, persisted?.version as number)

            const grant: ApprovalGrant = {
                id: approvalId,
                runId,
                principalId: principal.principalId,
                tenantId: principal.tenantId,
                toolName: 'publish_draft',
                inputDigest: 'f'.repeat(64),
                expiresAt: Date.now() + 60_000,
            }
            await approvalStore.createPending(grant, principal.principalId)
            assert.equal(await approvalStore.approve(approvalId, principal.tenantId, 'human-reviewer'), true)
            const claims = {
                runId,
                principalId: principal.principalId,
                tenantId: principal.tenantId,
                toolName: grant.toolName,
                inputDigest: grant.inputDigest,
                now: Date.now(),
            }
            const consumed = await Promise.all([
                approvalStore.consume(grant, claims),
                approvalStore.consume(grant, claims),
            ])
            assert.deepEqual(consumed.sort(), [false, true])
            assert.equal((await approvalStore.get(approvalId, principal.tenantId))?.state, 'consumed')
        } finally {
            await model.deleteOne({ id: runId })
            await approvalModel.deleteOne({ id: approvalId })
            await connection.close()
        }
    }
)
