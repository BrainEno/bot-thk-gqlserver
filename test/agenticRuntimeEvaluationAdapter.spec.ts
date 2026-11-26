import assert from 'node:assert/strict'
import test from 'node:test'
import {
    AgentRunInput,
    AgentRunResult,
    PendingApproval,
    AgentRuntimeEvaluationError,
    AgentRuntimeEvaluationSession,
    RunEvent,
    RunSnapshot,
    createAgentRuntimeEvaluationExecutor,
    createIsolatedEvaluationFactory,
    runVersionedEvaluationSuite,
} from '../src/agentic'
import { AgentTool } from '../src/agentic'

const makeSafeReadTool = (): AgentTool => ({
    name: 'read_status',
    description: 'Read a fixed public status value from an in-memory fixture.',
    inputSchema: {
        type: 'object',
        properties: { key: { type: 'string', enum: ['public-status'] } },
        required: ['key'],
        additionalProperties: false,
    },
    sideEffect: 'read_only',
    requiredPermissions: ['records_read'],
    execute: async () => ({ state: 'ready' }),
})

const input: AgentRunInput = {
    runId: 'adapter-run-0001',
    task: 'Read the public status record.',
    principal: {
        id: 'principal-eval',
        tenantId: 'tenant-eval',
        permissions: ['records_read'],
    },
    budget: {
        maxSteps: 4,
        maxToolCalls: 2,
        maxDurationMs: 5_000,
        perOperationTimeoutMs: 1_000,
        maxOutputChars: 1_000,
    },
}

const result: AgentRunResult = {
    runId: input.runId,
    status: 'succeeded',
    output: 'The public status is ready.',
    steps: 2,
    toolCalls: 1,
}

const eventList: RunEvent[] = [
    { type: 'run_created', at: 1 },
    { type: 'run_started', at: 2, status: 'running' },
    { type: 'model_step_started', at: 3, step: 1 },
    {
        type: 'tool_call_succeeded',
        at: 4,
        toolName: 'read_status',
        detail: { response: { state: 'ready', nested: ['a', 'b'] } },
    },
    { type: 'run_succeeded', at: 5, status: 'succeeded' },
]

const snapshot: RunSnapshot = {
    id: result.runId,
    tenantId: input.principal.tenantId,
    principalId: input.principal.id,
    status: result.status,
    version: 8,
    stepCount: result.steps,
    toolCallCount: result.toolCalls,
    createdAt: 1,
    updatedAt: 5,
    output: result.output,
    events: eventList,
}

const makeFixture = () => ({
    id: 'adapter-safe-read',
    input,
    expectedStatus: 'succeeded' as const,
    expectedTools: ['read_status'],
    requiredEventTypes: ['run_succeeded' as const],
    minSteps: 2,
    maxSteps: 2,
    minToolCalls: 1,
    maxToolCalls: 1,
})

const makeSession = (
    overrides: {
        run?: (received: AgentRunInput) => Promise<AgentRunResult>
        get?: (id: string, scope: { tenantId: string; principalId: string }) => Promise<RunSnapshot | null>
    } = {}
): AgentRuntimeEvaluationSession => ({
    runtime: {
        run: overrides.run ?? (async () => result),
    },
    store: {
        create: async () => undefined,
        get: overrides.get ?? (async () => snapshot),
        appendEvent: async () => snapshot,
        transition: async () => snapshot,
    },
})

const execute = (session: AgentRuntimeEvaluationSession) =>
    createAgentRuntimeEvaluationExecutor(() => session)

const catchAdapterError = async (
    operation: Promise<unknown>,
    expected: AgentRuntimeEvaluationError['code']
): Promise<void> => {
    await assert.rejects(operation, (error: unknown) => {
        assert.ok(error instanceof AgentRuntimeEvaluationError)
        assert.equal(error.code, expected)
        assert.equal(error.message, 'isolated runtime evaluation could not capture a consistent run')
        return true
    })
}

test('adapter invokes an isolated runtime with the fixture identity and returns its persisted trace', async () => {
    const received: AgentRunInput[] = []
    const scopeReads: Array<{ id: string; tenantId: string; principalId: string }> = []
    const session = makeSession({
        run: async (receivedInput) => {
            received.push(receivedInput)
            return result
        },
        get: async (id, scope) => {
            scopeReads.push({ id, ...scope })
            return snapshot
        },
    })

    const output = await execute(session)(makeFixture(), 0)

    assert.equal(received.length, 1)
    assert.equal(received[0].runId, input.runId)
    assert.equal(received[0].task, input.task)
    assert.deepEqual(received[0].principal, input.principal)
    assert.deepEqual(received[0].budget, input.budget)
    assert.deepEqual(scopeReads, [{
        id: input.runId,
        tenantId: input.principal.tenantId,
        principalId: input.principal.id,
    }])
    assert.deepEqual(output.result, result)
    assert.deepEqual(output.events, eventList)
    assert.notEqual(output.events, eventList)
})

test('adapter gives the scenario factory a defensive input copy and repetition context', async () => {
    let factoryInput: AgentRunInput | undefined
    let factoryContext: { caseId: string; repetition: number } | undefined
    const fixture = makeFixture()
    const executor = createAgentRuntimeEvaluationExecutor((receivedInput, context) => {
        factoryInput = receivedInput
        factoryContext = context
        const mutablePermissions = receivedInput.principal.permissions as string[]
        mutablePermissions.push('mutated_by_factory')
        return makeSession()
    })

    await executor(fixture, 7)

    assert.notEqual(factoryInput, fixture.input)
    assert.notEqual(factoryInput?.principal, fixture.input.principal)
    assert.notEqual(factoryInput?.principal.permissions, fixture.input.principal.permissions)
    assert.deepEqual(fixture.input.principal.permissions, ['records_read'])
    assert.deepEqual(factoryContext, { caseId: fixture.id, repetition: 7 })
})

test('adapter does not pass caller abort signals into isolated evaluation sessions', async () => {
    const controller = new AbortController()
    const signalInput: AgentRunInput = { ...input, signal: controller.signal }
    let passedInput: AgentRunInput | undefined
    const executor = createAgentRuntimeEvaluationExecutor((received) => {
        passedInput = received
        return makeSession()
    })

    await executor({ ...makeFixture(), input: signalInput }, 0)

    assert.equal(passedInput?.signal, undefined)
})

test('adapter rejects a session without the runtime and store contracts', async () => {
    const executor = createAgentRuntimeEvaluationExecutor(
        () => undefined as unknown as AgentRuntimeEvaluationSession
    )

    await catchAdapterError(executor(makeFixture(), 0), 'invalid_factory_session')
})

test('adapter rejects a malformed session with a non-callable runtime method', async () => {
    const executor = createAgentRuntimeEvaluationExecutor(() => ({
        runtime: { run: null },
        store: { get: async () => snapshot },
    } as unknown as AgentRuntimeEvaluationSession))

    await catchAdapterError(executor(makeFixture(), 0), 'invalid_factory_session')
})

test('adapter rejects a malformed session with a non-callable scoped store read', async () => {
    const executor = createAgentRuntimeEvaluationExecutor(() => ({
        runtime: { run: async () => result },
        store: { get: null },
    } as unknown as AgentRuntimeEvaluationSession))

    await catchAdapterError(executor(makeFixture(), 0), 'invalid_factory_session')
})

test('adapter rejects a result with the wrong run identifier before reading any snapshot', async () => {
    let reads = 0
    const executor = createAgentRuntimeEvaluationExecutor(() => makeSession({
        run: async () => ({ ...result, runId: 'other-run-0001' }),
        get: async () => {
            reads += 1
            return snapshot
        },
    }))

    await catchAdapterError(executor(makeFixture(), 0), 'run_id_mismatch')
    assert.equal(reads, 0)
})

test('adapter rejects a missing scoped snapshot', async () => {
    const executor = createAgentRuntimeEvaluationExecutor(() => makeSession({
        get: async () => null,
    }))

    await catchAdapterError(executor(makeFixture(), 0), 'run_snapshot_missing')
})

test('adapter rejects snapshots with cross-tenant identity', async () => {
    const executor = createAgentRuntimeEvaluationExecutor(() => makeSession({
        get: async () => ({ ...snapshot, tenantId: 'other-tenant' }),
    }))

    await catchAdapterError(executor(makeFixture(), 0), 'run_snapshot_mismatch')
})

test('adapter rejects snapshots with cross-principal identity', async () => {
    const executor = createAgentRuntimeEvaluationExecutor(() => makeSession({
        get: async () => ({ ...snapshot, principalId: 'other-principal' }),
    }))

    await catchAdapterError(executor(makeFixture(), 0), 'run_snapshot_mismatch')
})

test('adapter rejects snapshots that refer to a different id', async () => {
    const executor = createAgentRuntimeEvaluationExecutor(() => makeSession({
        get: async () => ({ ...snapshot, id: 'different-run-0001' }),
    }))

    await catchAdapterError(executor(makeFixture(), 0), 'run_snapshot_mismatch')
})

test('adapter rejects a snapshot whose terminal status differs from the runtime result', async () => {
    const executor = createAgentRuntimeEvaluationExecutor(() => makeSession({
        get: async () => ({ ...snapshot, status: 'failed' }),
    }))

    await catchAdapterError(executor(makeFixture(), 0), 'run_snapshot_mismatch')
})

test('adapter rejects mismatched step and tool counters', async (t) => {
    const variants: Array<{ label: string; patch: Partial<RunSnapshot> }> = [
        { label: 'steps lower than the returned result', patch: { stepCount: 1 } },
        { label: 'steps higher than the returned result', patch: { stepCount: 3 } },
        { label: 'tool calls lower than the returned result', patch: { toolCallCount: 0 } },
        { label: 'tool calls higher than the returned result', patch: { toolCallCount: 2 } },
    ]
    for (const variant of variants) {
        await t.test(variant.label, async () => {
            const executor = createAgentRuntimeEvaluationExecutor(() => makeSession({
                get: async () => ({ ...snapshot, ...variant.patch }),
            }))
            await catchAdapterError(executor(makeFixture(), 0), 'run_snapshot_mismatch')
        })
    }
})

test('adapter rejects mismatched persisted output', async () => {
    const executor = createAgentRuntimeEvaluationExecutor(() => makeSession({
        get: async () => ({ ...snapshot, output: 'different output' }),
    }))

    await catchAdapterError(executor(makeFixture(), 0), 'run_snapshot_mismatch')
})

test('adapter verifies each pending approval claim against persisted state', async (t) => {
    const pending = {
        id: 'approval-0001',
        toolName: 'write_record',
        inputDigest: 'digest:exact-input',
        expiresAt: 10_000,
    }
    const pendingResult: AgentRunResult = {
        ...result,
        status: 'waiting_for_approval',
        pendingApproval: pending,
    }
    const pendingSnapshot: RunSnapshot = {
        ...snapshot,
        status: 'waiting_for_approval',
        pendingApproval: pending,
    }
    const wrongClaims: Array<{ label: string; patch: Partial<PendingApproval> | undefined }> = [
        { label: 'approval identifier', patch: { id: 'approval-other' } },
        { label: 'tool identifier', patch: { toolName: 'other_tool' } },
        { label: 'exact input digest', patch: { inputDigest: 'digest:other-input' } },
        { label: 'expiry timestamp', patch: { expiresAt: 9_999 } },
        { label: 'missing approval', patch: undefined },
    ]

    for (const variant of wrongClaims) {
        await t.test(variant.label, async () => {
            const executor = createAgentRuntimeEvaluationExecutor(() => makeSession({
                run: async () => pendingResult,
                get: async () => ({ ...pendingSnapshot, pendingApproval: variant.patch } as RunSnapshot),
            }))
            await catchAdapterError(executor(makeFixture(), 0), 'run_snapshot_mismatch')
        })
    }
})

test('adapter safely copies nested event payloads and prevents output mutation from changing the store', async () => {
    const sourceEvents: RunEvent[] = [{
        type: 'tool_call_succeeded',
        at: 42,
        toolName: 'read_status',
        detail: { record: { status: 'ready', tags: ['public', 'bounded'] } },
    }]
    const sourceSnapshot = { ...snapshot, events: sourceEvents }
    const executor = createAgentRuntimeEvaluationExecutor(() => makeSession({
        get: async () => sourceSnapshot,
    }))

    const output = await executor(makeFixture(), 0)
    const resultEvent = output.events[0]
    const record = resultEvent.detail?.record as { status: string; tags: string[] }
    record.tags.push('caller-change')

    assert.deepEqual(
        (sourceEvents[0].detail?.record as { tags: string[] }).tags,
        ['public', 'bounded']
    )
    assert.notEqual(output.events, sourceSnapshot.events)
    assert.notEqual(output.events[0], sourceSnapshot.events[0])
})

test('adapter preserves object keys such as prototype-looking names as ordinary data', async () => {
    const detail = JSON.parse('{"__proto__":{"polluted":true},"constructor":"safe"}')
    const unusualEvent: RunEvent = {
        type: 'tool_call_succeeded',
        at: 43,
        toolName: 'read_status',
        detail,
    }
    const executor = createAgentRuntimeEvaluationExecutor(() => makeSession({
        get: async () => ({ ...snapshot, events: [unusualEvent] }),
    }))

    const output = await executor(makeFixture(), 0)

    assert.equal(Object.prototype.hasOwnProperty.call(output.events[0].detail, '__proto__'), true)
    assert.deepEqual(output.events[0].detail?.__proto__, { polluted: true })
    assert.equal(({} as { polluted?: boolean }).polluted, undefined)
})

test('adapter isolates each repetition with a separately constructed in-memory runtime', async () => {
    let factoryCalls = 0
    const executor = createAgentRuntimeEvaluationExecutor(() => {
        factoryCalls += 1
        return makeSession()
    })

    await executor(makeFixture(), 0)
    await executor(makeFixture(), 1)

    assert.equal(factoryCalls, 2)
})

test('suite runner can evaluate the production runtime through only a scripted fake and in-memory store', async () => {
    const fixture = makeFixture()
    const factory = createIsolatedEvaluationFactory(() => ({
        decisions: [
            {
                kind: 'tool_call',
                callId: 'call-safe-read-1',
                name: 'read_status',
                input: { key: 'public-status' },
            },
            { kind: 'final', output: 'The public status is ready.' },
        ],
        tools: [makeSafeReadTool()],
        clock: () => 100,
    }))
    const suite = {
        schemaVersion: 1 as const,
        suiteId: 'runtime.adapter.integration',
        cases: [fixture],
        repetitions: 2,
        deterministic: true,
        thresholds: {
            minimumScore: 1,
            maximumFailedCases: 0,
            maximumUnstableCases: 0,
        },
    }

    const report = await runVersionedEvaluationSuite(
        suite,
        createAgentRuntimeEvaluationExecutor(factory),
        () => 100
    )

    assert.equal(report.gate.passed, true)
    assert.equal(report.passedCases, 1)
    assert.equal(report.cases[0].stable, true)
    assert.deepEqual(report.cases[0].repetitions.map((entry) => entry.passed), [true, true])
})

test('adapter propagates factory errors without rewriting secret-bearing error messages', async () => {
    const executor = createAgentRuntimeEvaluationExecutor(() => {
        throw new Error('fixture-private secret')
    })

    await assert.rejects(executor(makeFixture(), 0), /fixture-private secret/)
})

test('adapter propagates runtime errors so the suite runner can sanitize them at its boundary', async () => {
    const executor = createAgentRuntimeEvaluationExecutor(() => makeSession({
        run: async () => { throw new Error('runtime-private secret') },
    }))

    await assert.rejects(executor(makeFixture(), 0), /runtime-private secret/)
})

test('adapter propagates store errors and never fabricates an empty event list', async () => {
    const executor = createAgentRuntimeEvaluationExecutor(() => makeSession({
        get: async () => { throw new Error('persistence-private secret') },
    }))

    await assert.rejects(executor(makeFixture(), 0), /persistence-private secret/)
})

test('adapter output omits store-internal checkpoint and unrequested snapshot fields', async () => {
    const internalSnapshot: RunSnapshot = {
        ...snapshot,
        checkpoint: {
            version: 1,
            algorithm: 'aes-256-gcm',
            iv: 'test-iv',
            authTag: 'test-tag',
            ciphertext: 'secret-ciphertext-not-for-report',
        },
    }
    const executor = createAgentRuntimeEvaluationExecutor(() => makeSession({
        get: async () => internalSnapshot,
    }))

    const output = await executor(makeFixture(), 0)
    const serialized = JSON.stringify(output)

    assert.equal(serialized.includes('secret-ciphertext-not-for-report'), false)
    assert.deepEqual(Object.keys(output), ['result', 'events'])
})

 test('adapter compares persisted approval even when both sides omit it', async () => {
    const executor = createAgentRuntimeEvaluationExecutor(() => makeSession({
        run: async () => ({ ...result, pendingApproval: undefined }),
        get: async () => ({ ...snapshot, pendingApproval: undefined }),
    }))

    const output = await executor(makeFixture(), 0)

    assert.equal(output.result.pendingApproval, undefined)
})
