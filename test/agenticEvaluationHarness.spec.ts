import assert from 'node:assert/strict'
import test from 'node:test'
import {
    AgentRunInput,
    AgentTool,
    EvaluationHarnessConfigurationError,
    IsolatedEvaluationScenario,
    createAgentRuntimeEvaluationExecutor,
    createIsolatedEvaluationFactory,
    createIsolatedEvaluationSession,
} from '../src/agentic'

const makeInput = (runId = 'harness-run-0001'): AgentRunInput => ({
    runId,
    task: 'Read the local fixture value.',
    principal: {
        id: 'harness-user',
        tenantId: 'harness-tenant',
        permissions: ['fixture_read'],
    },
    budget: {
        maxSteps: 3,
        maxToolCalls: 1,
        maxDurationMs: 3_000,
        perOperationTimeoutMs: 1_000,
        maxOutputChars: 1_000,
    },
})

const makeFixtureTool = (execute: AgentTool['execute'] = async () => ({ value: 'local-only' })):
AgentTool => ({
    name: 'read_fixture',
    description: 'Return an in-memory fixture value and perform no external I/O.',
    inputSchema: {
        type: 'object',
        properties: { key: { type: 'string', enum: ['fixture'] } },
        required: ['key'],
        additionalProperties: false,
    },
    sideEffect: 'read_only',
    requiredPermissions: ['fixture_read'],
    execute,
})

const safeScenario = (overrides: Partial<IsolatedEvaluationScenario> = {}): IsolatedEvaluationScenario => ({
    decisions: [
        {
            kind: 'tool_call',
            callId: 'fixture-call-01',
            name: 'read_fixture',
            input: { key: 'fixture' },
        },
        { kind: 'final', output: 'The local fixture value is local-only.' },
    ],
    tools: [makeFixtureTool()],
    clock: () => 10_000,
    ...overrides,
})

test('isolated harness wires the real runtime to fake provider, memory store, and local tool registry', async () => {
    const session = await createIsolatedEvaluationSession(makeInput(), safeScenario())

    assert.equal(session.store.constructor.name, 'InMemoryRunStore')
    assert.equal(session.registry.names().join(','), 'read_fixture')
    assert.equal(session.provider.calls(), 0)
    const result = await session.runtime.run(makeInput())

    assert.equal(result.status, 'succeeded')
    assert.equal(result.output, 'The local fixture value is local-only.')
    assert.equal(result.steps, 2)
    assert.equal(result.toolCalls, 1)
    assert.equal(session.provider.calls(), 2)
    const stored = await session.store.get(result.runId, {
        tenantId: 'harness-tenant',
        principalId: 'harness-user',
    })
    assert.ok(stored)
    assert.equal(stored?.events.some((event) => event.type === 'run_succeeded'), true)
    assert.equal(session.traceWriter.readAll().length > 0, true)
})

test('harness scenario resolver receives a copy of the principal and exact repetition context', async () => {
    let capturedInput: AgentRunInput | undefined
    const capturedContexts: Array<{ caseId: string; repetition: number }> = []
    const factory = createIsolatedEvaluationFactory((input, context) => {
        capturedInput = input
        capturedContexts.push(context)
        return safeScenario({ decisions: [{ kind: 'final', output: `case ${context.caseId}` }] })
    })

    const first = await factory(makeInput(), { caseId: 'scenario-a', repetition: 0 })
    const second = await factory(makeInput('harness-run-0002'), { caseId: 'scenario-a', repetition: 1 })
    await first.runtime.run(makeInput())
    await second.runtime.run(makeInput('harness-run-0002'))

    assert.deepEqual(capturedContexts, [
        { caseId: 'scenario-a', repetition: 0 },
        { caseId: 'scenario-a', repetition: 1 },
    ])
    assert.notEqual(capturedInput?.principal, makeInput().principal)
})

test('each factory call receives a fresh provider, registry, trace writer, and store', async () => {
    const factory = createIsolatedEvaluationFactory(() => safeScenario({
        decisions: [{ kind: 'final', output: 'done' }],
    }))
    const one = await factory(makeInput(), { caseId: 'one', repetition: 0 })
    const two = await factory(makeInput('harness-run-0002'), { caseId: 'two', repetition: 0 })

    assert.notEqual(one.runtime, two.runtime)
    assert.notEqual(one.store, two.store)
    assert.notEqual(one.provider, two.provider)
    assert.notEqual(one.registry, two.registry)
})

test('fresh factory sessions allow repeated run ids without sharing persisted records', async () => {
    const factory = createIsolatedEvaluationFactory(() => safeScenario({
        decisions: [{ kind: 'final', output: 'repeatable' }],
    }))
    const first = await factory(makeInput(), { caseId: 'repeat', repetition: 0 })
    const second = await factory(makeInput(), { caseId: 'repeat', repetition: 1 })

    assert.equal((await first.runtime.run(makeInput())).status, 'succeeded')
    assert.equal((await second.runtime.run(makeInput())).status, 'succeeded')
})

test('resolver can vary deterministic scripts by repetition without sharing provider cursors', async () => {
    const factory = createIsolatedEvaluationFactory((_input, context) => safeScenario({
        decisions: [{ kind: 'final', output: `repeat-${context.repetition}` }],
    }))

    const outputs: string[] = []
    for (const repetition of [0, 1, 2]) {
        const session = await factory(makeInput(`harness-run-000${repetition + 1}`), {
            caseId: 'repeat-suite',
            repetition,
        })
        const result = await session.runtime.run(makeInput(`harness-run-000${repetition + 1}`))
        outputs.push(result.output ?? '')
    }

    assert.deepEqual(outputs, ['repeat-0', 'repeat-1', 'repeat-2'])
})

test('harness refuses an empty model decision script', async () => {
    const factory = createIsolatedEvaluationFactory(() => safeScenario({ decisions: [] }))

    await assert.rejects(
        factory(makeInput(), { caseId: 'empty-script', repetition: 0 }),
        (error: unknown) => {
            assert.ok(error instanceof EvaluationHarnessConfigurationError)
            assert.equal(error.code, 'invalid_decisions')
            return true
        }
    )
})

test('harness rejects malformed model decision unions', async (t) => {
    const invalid: unknown[] = [
        null,
        {},
        { kind: 'unknown' },
        { kind: 'final', output: 42 },
        { kind: 'tool_call', name: 'read_fixture' },
        { kind: 'tool_call', callId: 3, name: 'read_fixture', input: {} },
    ]
    for (const decision of invalid) {
        await t.test(JSON.stringify(decision), async () => {
            const factory = createIsolatedEvaluationFactory(() => safeScenario({
                decisions: [decision] as IsolatedEvaluationScenario['decisions'],
            }))
            await assert.rejects(
                factory(makeInput(), { caseId: 'invalid-decision', repetition: 0 }),
                (error: unknown) => {
                    assert.ok(error instanceof EvaluationHarnessConfigurationError)
                    assert.equal(error.code, 'invalid_decisions')
                    return true
                }
            )
        })
    }
})

test('harness rejects a non-array tool collection', async () => {
    const factory = createIsolatedEvaluationFactory(() => ({
        ...safeScenario(),
        tools: null,
    } as unknown as IsolatedEvaluationScenario))

    await assert.rejects(
        factory(makeInput(), { caseId: 'invalid-tools', repetition: 0 }),
        (error: unknown) => {
            assert.ok(error instanceof EvaluationHarnessConfigurationError)
            assert.equal(error.code, 'invalid_tool_list')
            return true
        }
    )
})

test('harness rejects malformed tool objects before registering them', async () => {
    const factory = createIsolatedEvaluationFactory(() => safeScenario({
        tools: [null as unknown as AgentTool],
    }))

    await assert.rejects(
        factory(makeInput(), { caseId: 'invalid-tool', repetition: 0 }),
        (error: unknown) => {
            assert.ok(error instanceof EvaluationHarnessConfigurationError)
            assert.equal(error.code, 'invalid_tool_list')
            return true
        }
    )
})

test('harness rejects duplicate tool names with a stable configuration error', async () => {
    const factory = createIsolatedEvaluationFactory(() => safeScenario({
        tools: [makeFixtureTool(), makeFixtureTool()],
    }))

    await assert.rejects(
        factory(makeInput(), { caseId: 'duplicate-tools', repetition: 0 }),
        (error: unknown) => {
            assert.ok(error instanceof EvaluationHarnessConfigurationError)
            assert.equal(error.code, 'duplicate_tool')
            return true
        }
    )
})

test('harness accepts no tools for pure text completion cases', async () => {
    const session = await createIsolatedEvaluationSession(makeInput(), safeScenario({
        decisions: [{ kind: 'final', output: 'No tools were needed.' }],
        tools: [],
    }))

    assert.deepEqual(session.registry.names(), [])
    const result = await session.runtime.run(makeInput())
    assert.equal(result.output, 'No tools were needed.')
    assert.equal(result.toolCalls, 0)
})

test('harness local tool sees only the fixture principal and run-scoped context', async () => {
    const observations: Array<{ runId: string; principalId: string; tenantId: string }> = []
    const tool = makeFixtureTool(async (_value, context) => {
        observations.push({
            runId: context.runId,
            principalId: context.principal.id,
            tenantId: context.principal.tenantId,
        })
        return { value: 'bounded' }
    })
    const session = await createIsolatedEvaluationSession(makeInput(), safeScenario({ tools: [tool] }))

    await session.runtime.run(makeInput())

    assert.deepEqual(observations, [{
        runId: 'harness-run-0001',
        principalId: 'harness-user',
        tenantId: 'harness-tenant',
    }])
})

test('harness does not silently permit write tools without a configured approval workflow', async () => {
    const writeTool: AgentTool = {
        ...makeFixtureTool(),
        name: 'write_fixture',
        description: 'A local write fixture which must remain approval-gated.',
        sideEffect: 'write',
    }
    let sideEffectCount = 0
    const dangerousTool: AgentTool = {
        ...writeTool,
        execute: async () => {
            sideEffectCount += 1
            return { changed: true }
        },
    }
    const session = await createIsolatedEvaluationSession(makeInput(), safeScenario({
        decisions: [{
            kind: 'tool_call',
            callId: 'write-call-01',
            name: 'write_fixture',
            input: { key: 'fixture' },
        }],
        tools: [dangerousTool],
    }))

    const result = await session.runtime.run(makeInput())

    assert.equal(result.status, 'failed')
    assert.equal(sideEffectCount, 0)
    assert.equal(result.pendingApproval, undefined)
})

test('harness returns no external trace records unless the in-memory redacting writer is inspected', async () => {
    const session = await createIsolatedEvaluationSession(makeInput(), safeScenario({
        decisions: [{ kind: 'final', output: 'fixture output' }],
    }))

    assert.deepEqual(session.traceWriter.readAll(), [])
    await session.runtime.run(makeInput())
    const trace = session.traceWriter.readAll()

    assert.ok(trace.length > 0)
    assert.equal(trace.every((record) => record.runId === 'harness-run-0001'), true)
    assert.equal(trace.every((record) => record.tenantId === 'harness-tenant'), true)
})

test('script exhaustion fails closed instead of inventing an assistant response', async () => {
    const session = await createIsolatedEvaluationSession(makeInput(), safeScenario({
        decisions: [{
            kind: 'tool_call',
            callId: 'only-call',
            name: 'read_fixture',
            input: { key: 'fixture' },
        }],
    }))
    const result = await session.runtime.run(makeInput())

    assert.equal(result.status, 'failed')
    assert.equal(result.output, undefined)
    assert.equal(session.provider.calls(), 2)
})

test('factory scenarios can be asynchronous and are resolved before creating collaborators', async () => {
    const order: string[] = []
    const factory = createIsolatedEvaluationFactory(async (_input, context) => {
        await Promise.resolve()
        order.push(`resolved:${context.caseId}`)
        return safeScenario({ decisions: [{ kind: 'final', output: 'ready' }] })
    })

    const session = await factory(makeInput(), { caseId: 'async-scenario', repetition: 0 })

    assert.deepEqual(order, ['resolved:async-scenario'])
    assert.equal(session.provider.calls(), 0)
})

test('factory passes cloned principal data so scenario code cannot mutate the suite fixture', async () => {
    const original = makeInput()
    const factory = createIsolatedEvaluationFactory((received) => {
        const mutablePrincipal = received.principal as unknown as { id: string; permissions: string[] }
        mutablePrincipal.permissions.push('injected')
        mutablePrincipal.id = 'changed'
        return safeScenario({ decisions: [{ kind: 'final', output: 'done' }] })
    })

    await factory(original, { caseId: 'immutable-input', repetition: 0 })

    assert.equal(original.principal.id, 'harness-user')
    assert.deepEqual(original.principal.permissions, ['fixture_read'])
})

test('scenario clock is used consistently by store and runtime event timestamps', async () => {
    let tick = 50_000
    const clock = () => tick++
    const session = await createIsolatedEvaluationSession(makeInput(), safeScenario({
        decisions: [{ kind: 'final', output: 'clocked' }],
        clock,
    }))

    const result = await session.runtime.run(makeInput())
    const stored = await session.store.get(result.runId, {
        tenantId: 'harness-tenant',
        principalId: 'harness-user',
    })

    assert.ok(stored)
    assert.equal(stored?.createdAt, 50_000)
    assert.ok(stored?.events.every((event) => Number.isFinite(event.at)))
})

test('isolated executor composes a resolver with suite case and repetition identity', async () => {
    const contexts: string[] = []
    const factory = createIsolatedEvaluationFactory((_input, context) => {
        contexts.push(`${context.caseId}:${context.repetition}`)
        return safeScenario({
            decisions: [{ kind: 'final', output: 'public fixture result' }],
            tools: [],
        })
    })
    const executor = createAgentRuntimeEvaluationExecutor(factory)
    const fixture = {
        id: 'harness-compose',
        input: makeInput(),
        expectedStatus: 'succeeded' as const,
        outputIncludes: 'public fixture',
        minSteps: 1,
        maxSteps: 1,
        minToolCalls: 0,
        maxToolCalls: 0,
    }

    await executor(fixture, 0)
    await executor(fixture, 1)

    assert.deepEqual(contexts, ['harness-compose:0', 'harness-compose:1'])
})
