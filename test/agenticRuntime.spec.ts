import assert from 'node:assert/strict'
import test from 'node:test'
import {
    AgentPrincipal,
    AgentTool,
    AesGcmCheckpointCipher,
    ApprovalGrant,
    ApprovalVerifier,
    InMemoryRunStore,
    ModelDecision,
    PermissionPolicy,
    ScriptedFakeProvider,
    ToolRegistry,
    digestJson,
} from '../src/agentic'
import { AgentRuntime } from '../src/agentic/runtime'
import { MemoryApprovalWorkflow } from './helpers/memoryApprovalWorkflow'

const principal: AgentPrincipal = {
    id: 'user-17',
    tenantId: 'tenant-a',
    permissions: ['records_read', 'drafts_write'],
}

const valueSchema = {
    type: 'object' as const,
    required: ['value'],
    properties: { value: { type: 'string' as const, minLength: 1, maxLength: 80 } },
}

const echoTool = (execute: AgentTool['execute'] = async (input) => input): AgentTool => ({
    name: 'echo_value',
    description: 'Return a bounded input value for deterministic tests.',
    inputSchema: valueSchema,
    sideEffect: 'read_only',
    requiredPermissions: ['records_read'],
    execute,
})

const makeRuntime = (options: {
    script: readonly ModelDecision[]
    tool?: AgentTool
    policy?: PermissionPolicy
    store?: InMemoryRunStore
    approvals?: MemoryApprovalWorkflow
}): {
    runtime: AgentRuntime
    store: InMemoryRunStore
    provider: ScriptedFakeProvider
    approvals: MemoryApprovalWorkflow
} => {
    const store = options.store ?? new InMemoryRunStore()
    const provider = new ScriptedFakeProvider(options.script)
    const approvals = options.approvals ?? new MemoryApprovalWorkflow()
    const registry = new ToolRegistry()
    if (options.tool) registry.register(options.tool)
    const runtime = new AgentRuntime(
        provider,
        registry,
        options.policy ?? new PermissionPolicy(approvals),
        store,
        undefined,
        Date.now,
        new AesGcmCheckpointCipher(Buffer.alloc(32, 7)),
        approvals
    )
    return { runtime, store, provider, approvals }
}

const runInput = (overrides: Partial<Parameters<AgentRuntime['run']>[0]> = {}) => ({
    runId: 'run-12345678',
    task: 'Return a safe test value.',
    principal,
    ...overrides,
})

const toolCall = (name = 'echo_value', value = 'hello'): ModelDecision => ({
    kind: 'tool_call',
    callId: 'call-1',
    name,
    input: { value },
})

test('runtime performs a registered read-only tool call and completes within budget', async () => {
    const { runtime, store, provider } = makeRuntime({
        script: [toolCall(), { kind: 'final', output: 'answer: hello' }],
        tool: echoTool(),
    })
    const response = await runtime.run(runInput())
    const snapshot = await store.get(response.runId, {
        tenantId: principal.tenantId,
        principalId: principal.id,
    })

    assert.equal(response.status, 'succeeded')
    assert.equal(response.output, 'answer: hello')
    assert.equal(response.steps, 2)
    assert.equal(response.toolCalls, 1)
    assert.equal(provider.calls(), 2)
    assert.equal(snapshot?.status, 'succeeded')
    assert.ok(snapshot?.events.some((event) => event.type === 'tool_call_succeeded'))
})

test('runtime rejects unknown tools without executing anything', async () => {
    let executed = false
    const { runtime, store } = makeRuntime({
        script: [toolCall('unregistered_tool')],
        tool: echoTool(async () => {
            executed = true
            return { value: 'no' }
        }),
    })
    const response = await runtime.run(runInput())
    const snapshot = await store.get(response.runId, {
        tenantId: principal.tenantId,
        principalId: principal.id,
    })

    assert.equal(response.status, 'failed')
    assert.equal(executed, false)
    assert.ok(snapshot?.events.some((event) => event.type === 'run_failed'))
    assert.equal(snapshot?.events.some((event) => JSON.stringify(event).includes('hello')), false)
})

test('runtime rejects schema-invalid tool arguments before policy or execution', async () => {
    let executed = false
    const { runtime } = makeRuntime({
        script: [toolCall('echo_value', '')],
        tool: echoTool(async () => {
            executed = true
            return { value: 'unexpected' }
        }),
    })
    const response = await runtime.run(runInput())
    assert.equal(response.status, 'failed')
    assert.equal(executed, false)
})

test('runtime honors permission denial and never calls the tool', async () => {
    let executed = false
    const { runtime } = makeRuntime({
        script: [toolCall()],
        tool: echoTool(async () => {
            executed = true
            return { value: 'unexpected' }
        }),
    })
    const response = await runtime.run(runInput({
        principal: { ...principal, permissions: [] },
    }))
    assert.equal(response.status, 'failed')
    assert.equal(executed, false)
})

test('runtime applies an operation timeout to policy and does not start the tool', async () => {
    let executed = false
    const { runtime } = makeRuntime({
        script: [toolCall()],
        tool: echoTool(async () => {
            executed = true
            return { value: 'unexpected' }
        }),
        policy: {
            async authorize() {
                return new Promise(() => undefined)
            },
        },
    })
    const response = await runtime.run(runInput({
        budget: { maxSteps: 1, maxToolCalls: 1, maxDurationMs: 100, perOperationTimeoutMs: 5, maxOutputChars: 100 },
    }))
    assert.equal(response.status, 'failed')
    assert.equal(executed, false)
})

test('runtime suspends writes for approval and does not run the side effect', async () => {
    let writes = 0
    const writeTool: AgentTool = {
        ...echoTool(async () => {
            writes += 1
            return { ok: true }
        }),
        name: 'write_draft',
        sideEffect: 'write',
        requiredPermissions: ['drafts_write'],
    }
    const { runtime, store, approvals } = makeRuntime({ script: [toolCall('write_draft')], tool: writeTool })
    const response = await runtime.run(runInput())
    const snapshot = await store.get(response.runId, {
        tenantId: principal.tenantId,
        principalId: principal.id,
    })
    assert.equal(response.status, 'waiting_for_approval')
    assert.equal(writes, 0)
    assert.equal(snapshot?.status, 'waiting_for_approval')
    assert.equal(response.pendingApproval?.toolName, 'write_draft')
    assert.match(response.pendingApproval?.id ?? '', /^[A-Za-z0-9_-]{22,128}$/)
    assert.match(response.pendingApproval?.inputDigest ?? '', /^[a-f0-9]{64}$/)
    assert.ok(snapshot?.checkpoint?.ciphertext)
    assert.equal(JSON.stringify(snapshot).includes('Return a safe test value.'), false)
    assert.equal(JSON.stringify(snapshot).includes('"hello"'), false)
    assert.equal((await approvals.get(response.pendingApproval?.id ?? '', principal.tenantId))?.state, 'pending')
})

test('runtime resumes an encrypted checkpoint after independent approval and executes once', async () => {
    let writes = 0
    const writeTool: AgentTool = {
        ...echoTool(async () => {
            writes += 1
            return { saved: true }
        }),
        name: 'write_draft',
        sideEffect: 'write',
        requiredPermissions: ['drafts_write'],
    }
    const { runtime, store, approvals, provider } = makeRuntime({
        script: [toolCall('write_draft', 'approved content'), { kind: 'final', output: 'saved' }],
        tool: writeTool,
    })
    const first = await runtime.run(runInput())
    assert.equal(first.status, 'waiting_for_approval')
    assert.equal(writes, 0)
    const approvalId = first.pendingApproval?.id
    assert.ok(approvalId)
    assert.equal(await approvals.approve(approvalId, principal.tenantId, 'reviewer-2'), true)

    const resumed = await runtime.resume({
        runId: first.runId,
        approvalId,
        principal,
    })
    const snapshot = await store.get(first.runId, {
        tenantId: principal.tenantId,
        principalId: principal.id,
    })
    assert.equal(resumed.status, 'succeeded')
    assert.equal(resumed.output, 'saved')
    assert.equal(writes, 1)
    assert.equal(provider.calls(), 2)
    assert.equal(snapshot?.checkpoint, undefined)
    assert.equal(snapshot?.pendingApproval, undefined)
    assert.equal((await approvals.get(approvalId, principal.tenantId))?.state, 'consumed')
    await assert.rejects(
        runtime.resume({ runId: first.runId, approvalId, principal }),
        /not available/
    )
})

test('concurrent resume attempts execute the approved side effect at most once', async () => {
    let writes = 0
    const writeTool: AgentTool = {
        ...echoTool(async () => {
            writes += 1
            return { written: true }
        }),
        name: 'write_draft',
        sideEffect: 'write',
        requiredPermissions: ['drafts_write'],
    }
    const { runtime, approvals } = makeRuntime({
        script: [toolCall('write_draft', 'concurrent approval'), { kind: 'final', output: 'done' }],
        tool: writeTool,
    })
    const pending = await runtime.run(runInput())
    const approvalId = pending.pendingApproval?.id
    assert.ok(approvalId)
    assert.equal(await approvals.approve(approvalId, principal.tenantId, 'reviewer-3'), true)

    const requests = [1, 2].map(() => runtime.resume({
        runId: pending.runId,
        approvalId,
        principal,
    }))
    const outcomes = await Promise.allSettled(requests)
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1)
    assert.equal(writes, 1)
})

test('runtime executes a write only with an exact one-use approval', async () => {
    let writes = 0
    const args = { value: 'publish me' }
    const writeTool: AgentTool = {
        ...echoTool(async () => {
            writes += 1
            return { published: true }
        }),
        name: 'write_draft',
        sideEffect: 'write',
        requiredPermissions: ['drafts_write'],
    }
    const grant: ApprovalGrant = {
        id: 'approval-1',
        runId: 'run-12345678',
        principalId: principal.id,
        tenantId: principal.tenantId,
        toolName: 'write_draft',
        inputDigest: digestJson(args),
        expiresAt: Date.now() + 60_000,
    }
    const verifier = new SingleUseVerifier(grant)
    const { runtime } = makeRuntime({
        script: [
            { kind: 'tool_call', callId: 'call-write', name: 'write_draft', input: args },
            { kind: 'final', output: 'published' },
        ],
        tool: writeTool,
        policy: new PermissionPolicy(verifier),
    })
    const response = await runtime.run(runInput({ approval: grant }))
    assert.equal(response.status, 'succeeded')
    assert.equal(writes, 1)
    assert.equal(verifier.consumed, true)
})

test('runtime stops when the provider asks for more tool calls than budgeted', async () => {
    const { runtime, provider } = makeRuntime({
        script: [toolCall(), toolCall('echo_value', 'again'), { kind: 'final', output: 'not reached' }],
        tool: echoTool(),
    })
    const response = await runtime.run(runInput({
        budget: { maxSteps: 3, maxToolCalls: 1, maxDurationMs: 1000, perOperationTimeoutMs: 100, maxOutputChars: 1000 },
    }))
    assert.equal(response.status, 'failed')
    assert.equal(response.toolCalls, 1)
    assert.equal(provider.calls(), 2)
})

test('runtime stops at the step limit without another provider request', async () => {
    const { runtime, provider } = makeRuntime({
        script: [toolCall(), { kind: 'final', output: 'must not run' }],
        tool: echoTool(),
    })
    const response = await runtime.run(runInput({
        budget: { maxSteps: 1, maxToolCalls: 1, maxDurationMs: 1000, perOperationTimeoutMs: 100, maxOutputChars: 1000 },
    }))
    assert.equal(response.status, 'failed')
    assert.equal(provider.calls(), 1)
})

test('runtime converts provider timeout into a generic failed run', async () => {
    const provider = {
        async nextAction() {
            return new Promise<ModelDecision>((resolve) => setTimeout(() => resolve({ kind: 'final', output: 'late' }), 50))
        },
    }
    const store = new InMemoryRunStore()
    const runtime = new AgentRuntime(
        provider,
        new ToolRegistry(),
        new PermissionPolicy(),
        store,
        undefined,
        Date.now
    )
    const response = await runtime.run(runInput({
        budget: { maxSteps: 1, maxToolCalls: 1, maxDurationMs: 100, perOperationTimeoutMs: 5, maxOutputChars: 100 },
    }))
    assert.equal(response.status, 'failed')
    assert.equal(response.output, undefined)
})

test('runtime honors external cancellation and records a terminal cancelled state', async () => {
    const controller = new AbortController()
    const provider = {
        async nextAction({ signal }: { signal: AbortSignal }) {
            return new Promise<ModelDecision>((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
            })
        },
    }
    const store = new InMemoryRunStore()
    const runtime = new AgentRuntime(provider, new ToolRegistry(), new PermissionPolicy(), store)
    const pending = runtime.run(runInput({ signal: controller.signal }))
    setTimeout(() => controller.abort(), 5)
    const response = await pending
    assert.equal(response.status, 'cancelled')
    const snapshot = await store.get(response.runId, { tenantId: principal.tenantId, principalId: principal.id })
    assert.equal(snapshot?.status, 'cancelled')
})

test('runtime rejects duplicate run IDs and malformed budgets', async () => {
    const { runtime } = makeRuntime({ script: [{ kind: 'final', output: 'done' }] })
    await runtime.run(runInput())
    await assert.rejects(() => runtime.run(runInput()), /already exists/)
    await assert.rejects(
        () => runtime.run(runInput({ budget: { maxSteps: 999 } })),
        /invalid agent budget/
    )
})

test('run history does not retain task text, tool arguments, or outputs in events', async () => {
    const secret = 'private-prompt-marker'
    const { runtime, store } = makeRuntime({
        script: [toolCall('echo_value', secret), { kind: 'final', output: 'done' }],
        tool: echoTool(async () => ({ token: secret })),
    })
    const response = await runtime.run(runInput({ task: secret }))
    const snapshot = await store.get(response.runId, { tenantId: principal.tenantId, principalId: principal.id })
    assert.equal(snapshot?.events.some((event) => JSON.stringify(event).includes(secret)), false)
})

class SingleUseVerifier implements ApprovalVerifier {
    consumed = false

    constructor(private readonly grant: ApprovalGrant) {}

    async consume(grant: ApprovalGrant, claims: Parameters<ApprovalVerifier['consume']>[1]) {
        const valid =
            !this.consumed &&
            grant.id === this.grant.id &&
            grant.runId === claims.runId &&
            grant.principalId === claims.principalId &&
            grant.tenantId === claims.tenantId &&
            grant.toolName === claims.toolName &&
            grant.inputDigest === claims.inputDigest &&
            grant.expiresAt > claims.now
        if (valid) this.consumed = true
        return valid
    }
}
