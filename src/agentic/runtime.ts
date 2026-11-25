import {
    AgentBudget,
    AgentPolicy,
    AgentRunInput,
    AgentRunResult,
    JsonValue,
    ModelDecision,
    AgentMessage,
    ModelProvider,
    RunEvent,
    RunSnapshot,
    RunStatus,
    RunStore,
    TraceSink,
} from './types'
import { canonicalJson } from './canonicalJson'
import { NoopTraceSink } from './trace'
import { ToolRegistry } from './toolRegistry'
import { isJsonValue, validateJsonSchema } from './validation'

const DEFAULT_BUDGET: AgentBudget = {
    maxSteps: 6,
    maxToolCalls: 4,
    maxDurationMs: 30_000,
    perOperationTimeoutMs: 8_000,
    maxOutputChars: 8_000,
}

const HARD_BUDGET: AgentBudget = {
    maxSteps: 20,
    maxToolCalls: 10,
    maxDurationMs: 120_000,
    perOperationTimeoutMs: 30_000,
    maxOutputChars: 32_000,
}

export class AgentRuntimeError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'AgentRuntimeError'
    }
}

class OperationTimeoutError extends Error {
    constructor() {
        super('operation timed out')
        this.name = 'OperationTimeoutError'
    }
}

class RunCancelledError extends Error {
    constructor() {
        super('run cancelled')
        this.name = 'RunCancelledError'
    }
}

export class AgentRuntime {
    constructor(
        private readonly provider: ModelProvider,
        private readonly registry: ToolRegistry,
        private readonly policy: AgentPolicy,
        private readonly store: RunStore,
        private readonly trace: TraceSink = new NoopTraceSink(),
        private readonly clock: () => number = Date.now
    ) {
        this.registry.seal()
    }

    async run(input: AgentRunInput): Promise<AgentRunResult> {
        assertRunInput(input)
        const budget = normalizeBudget(input.budget)
        const createdAt = this.clock()
        let snapshot: RunSnapshot = {
            id: input.runId,
            tenantId: input.principal.tenantId,
            principalId: input.principal.id,
            status: 'queued',
            version: 0,
            stepCount: 0,
            toolCallCount: 0,
            createdAt,
            updatedAt: createdAt,
            events: [],
        }
        await this.store.create(snapshot)

        const deadline = createdAt + budget.maxDurationMs
        const controller = new AbortController()
        const cancel = () => controller.abort()
        input.signal?.addEventListener('abort', cancel, { once: true })
        if (input.signal?.aborted) controller.abort()

        const messages: AgentMessage[] = [{ role: 'user', content: input.task }]
        const tools = this.registry.descriptions()
        let steps = 0
        let toolCalls = 0

        try {
            snapshot = await this.record(snapshot, event('run_created', this.clock()))
            snapshot = await this.store.transition(input.runId, 'running', {}, snapshot.version)
            snapshot = await this.record(snapshot, event('run_started', this.clock(), { status: 'running' }))

            while (steps < budget.maxSteps) {
                this.ensureRunning(controller.signal, deadline)
                steps += 1
                snapshot = await this.record(
                    snapshot,
                    event('model_step_started', this.clock(), { step: steps })
                )

                const decision = await this.perform(
                    (signal) =>
                        this.provider.nextAction({
                            runId: input.runId,
                            messages,
                            tools,
                            signal,
                        }),
                    controller,
                    deadline,
                    budget.perOperationTimeoutMs
                )

                if (!isModelDecision(decision)) {
                    return await this.fail(input.runId, snapshot, steps, toolCalls, 'invalid model response')
                }
                if (decision.kind === 'final') {
                    if (decision.output.length > budget.maxOutputChars) {
                        return await this.fail(input.runId, snapshot, steps, toolCalls, 'output budget exceeded')
                    }
                    snapshot = await this.record(
                        snapshot,
                        event('run_succeeded', this.clock(), { status: 'succeeded' })
                    )
                    snapshot = await this.store.transition(
                        input.runId,
                        'succeeded',
                        { output: decision.output, stepCount: steps, toolCallCount: toolCalls },
                        snapshot.version
                    )
                    return result(snapshot)
                }

                toolCalls += 1
                snapshot = await this.record(
                    snapshot,
                    event('tool_call_requested', this.clock(), {
                        step: steps,
                        toolName: decision.name,
                    })
                )
                if (toolCalls > budget.maxToolCalls) {
                    return await this.fail(input.runId, snapshot, steps, toolCalls - 1, 'tool call budget exceeded')
                }

                const tool = this.registry.get(decision.name)
                if (!tool) {
                    return await this.fail(input.runId, snapshot, steps, toolCalls, 'unregistered tool requested')
                }

                const validationIssues = validateJsonSchema(decision.input, tool.inputSchema)
                if (validationIssues.length > 0 || !isJsonValue(decision.input)) {
                    return await this.fail(input.runId, snapshot, steps, toolCalls, 'tool input rejected')
                }
                const args = decision.input as JsonValue
                const policyDecision = await this.perform(
                    () => this.policy.authorize({
                        runId: input.runId,
                        principal: input.principal,
                        tool,
                        args,
                        approval: input.approval,
                        now: this.clock(),
                    }),
                    controller,
                    deadline,
                    budget.perOperationTimeoutMs
                )

                if (policyDecision.kind === 'deny') {
                    snapshot = await this.record(
                        snapshot,
                        event('tool_call_denied', this.clock(), {
                            toolName: tool.name,
                            detail: { reason: policyDecision.reason },
                        })
                    )
                    return await this.fail(input.runId, snapshot, steps, toolCalls, 'tool call denied by policy')
                }
                if (policyDecision.kind === 'approval_required') {
                    snapshot = await this.record(
                        snapshot,
                        event('approval_required', this.clock(), {
                            toolName: tool.name,
                            detail: { inputDigest: policyDecision.inputDigest },
                        })
                    )
                    snapshot = await this.store.transition(
                        input.runId,
                        'waiting_for_approval',
                        { stepCount: steps, toolCallCount: toolCalls },
                        snapshot.version
                    )
                    return {
                        runId: input.runId,
                        status: 'waiting_for_approval',
                        steps,
                        toolCalls,
                        pendingApproval: {
                            toolName: tool.name,
                            inputDigest: policyDecision.inputDigest,
                        },
                    }
                }

                snapshot = await this.record(
                    snapshot,
                    event('tool_call_started', this.clock(), {
                        step: steps,
                        toolName: tool.name,
                    })
                )
                let toolOutput: JsonValue
                try {
                    toolOutput = await this.perform(
                        (signal) =>
                            tool.execute(args, {
                                runId: input.runId,
                                principal: input.principal,
                                signal,
                            }),
                        controller,
                        deadline,
                        budget.perOperationTimeoutMs
                    )
                } catch (error) {
                    if (isCancellation(error, input.signal, controller.signal)) {
                        throw error
                    }
                    snapshot = await this.record(
                        snapshot,
                        event('tool_call_failed', this.clock(), {
                            toolName: tool.name,
                            detail: { reason: 'tool execution failed' },
                        })
                    )
                    messages.push({
                        role: 'tool',
                        toolCallId: decision.callId,
                        content: 'Tool failed. Do not assume it succeeded.',
                    })
                    continue
                }

                if (!isJsonValue(toolOutput)) {
                    return await this.fail(input.runId, snapshot, steps, toolCalls, 'tool returned non-JSON output')
                }
                const serializedOutput = canonicalJson(toolOutput)
                if (serializedOutput.length > budget.maxOutputChars) {
                    return await this.fail(input.runId, snapshot, steps, toolCalls, 'tool output budget exceeded')
                }
                snapshot = await this.record(
                    snapshot,
                    event('tool_call_succeeded', this.clock(), {
                        toolName: tool.name,
                    })
                )
                messages.push({
                    role: 'assistant',
                    content: `Requested tool ${tool.name}.`,
                })
                messages.push({
                    role: 'tool',
                    toolCallId: decision.callId,
                    content: serializedOutput,
                })
            }

            return await this.fail(input.runId, snapshot, steps, toolCalls, 'step budget exceeded')
        } catch (error) {
            if (isCancellation(error, input.signal, controller.signal)) {
                return await this.cancel(input.runId, snapshot, steps, toolCalls)
            }
            if (error instanceof OperationTimeoutError) {
                return await this.fail(input.runId, snapshot, steps, toolCalls, 'run timed out')
            }
            return await this.fail(input.runId, snapshot, steps, toolCalls, 'agent execution failed')
        } finally {
            input.signal?.removeEventListener('abort', cancel)
        }
    }

    private async perform<T>(
        operation: (signal: AbortSignal) => Promise<T>,
        controller: AbortController,
        deadline: number,
        perOperationTimeoutMs: number
    ): Promise<T> {
        this.ensureRunning(controller.signal, deadline)
        const timeoutMs = Math.min(perOperationTimeoutMs, deadline - this.clock())
        if (timeoutMs <= 0) throw new OperationTimeoutError()

        return new Promise<T>((resolve, reject) => {
            const timeout = setTimeout(() => {
                const timeoutError = new OperationTimeoutError()
                controller.abort(timeoutError)
                reject(timeoutError)
            }, timeoutMs)
            const onAbort = () => {
                clearTimeout(timeout)
                reject(
                    controller.signal.reason instanceof OperationTimeoutError
                        ? controller.signal.reason
                        : new RunCancelledError()
                )
            }
            controller.signal.addEventListener('abort', onAbort, { once: true })
            Promise.resolve()
                .then(() => operation(controller.signal))
                .then(
                    (value) => {
                        try {
                            this.ensureRunning(controller.signal, deadline)
                            resolve(value)
                        } catch (error) {
                            reject(error)
                        }
                    },
                    reject
                )
                .finally(() => {
                    clearTimeout(timeout)
                    controller.signal.removeEventListener('abort', onAbort)
                })
        })
    }

    private ensureRunning(signal: AbortSignal, deadline: number): void {
        if (signal.aborted) {
            if (signal.reason instanceof OperationTimeoutError) throw signal.reason
            throw new RunCancelledError()
        }
        if (this.clock() >= deadline) throw new OperationTimeoutError()
    }

    private async record(snapshot: RunSnapshot, runEvent: RunEvent): Promise<RunSnapshot> {
        const updated = await this.store.appendEvent(snapshot.id, runEvent, snapshot.version)
        try {
            await this.trace.emit(runEvent, {
                runId: snapshot.id,
                tenantId: snapshot.tenantId,
            })
        } catch {
            // Optional telemetry must not change execution authorization or tool effects.
        }
        return updated
    }

    private async fail(
        runId: string,
        snapshot: RunSnapshot,
        steps: number,
        toolCalls: number,
        reason: string
    ): Promise<AgentRunResult> {
        if (snapshot.status !== 'running') return result(snapshot)
        snapshot = await this.record(
            snapshot,
            event('run_failed', this.clock(), {
                status: 'failed',
                detail: { reason },
            })
        )
        snapshot = await this.store.transition(
            runId,
            'failed',
            { stepCount: steps, toolCallCount: Math.min(toolCalls, steps) },
            snapshot.version
        )
        return result(snapshot)
    }

    private async cancel(
        runId: string,
        snapshot: RunSnapshot,
        steps: number,
        toolCalls: number
    ): Promise<AgentRunResult> {
        if (snapshot.status !== 'running') return result(snapshot)
        snapshot = await this.record(
            snapshot,
            event('run_cancelled', this.clock(), { status: 'cancelled' })
        )
        snapshot = await this.store.transition(
            runId,
            'cancelled',
            { stepCount: steps, toolCallCount: Math.min(toolCalls, steps) },
            snapshot.version
        )
        return result(snapshot)
    }
}

const assertRunInput = (input: AgentRunInput): void => {
    if (!/^[A-Za-z0-9_-]{8,96}$/.test(input.runId)) {
        throw new AgentRuntimeError('run id must be a non-secret opaque identifier')
    }
    if (!input.task.trim() || input.task.length > 16_000) {
        throw new AgentRuntimeError('task length must be 1 to 16000 characters')
    }
    if (
        !input.principal.id ||
        input.principal.id.length > 128 ||
        !input.principal.tenantId ||
        input.principal.tenantId.length > 128
    ) {
        throw new AgentRuntimeError('principal identity is invalid')
    }
}

const normalizeBudget = (overrides?: Partial<AgentBudget>): AgentBudget => {
    const candidate = { ...DEFAULT_BUDGET, ...overrides }
    for (const key of Object.keys(candidate) as (keyof AgentBudget)[]) {
        const value = candidate[key]
        if (!Number.isInteger(value) || value <= 0 || value > HARD_BUDGET[key]) {
            throw new AgentRuntimeError(`invalid agent budget: ${key}`)
        }
    }
    if (candidate.perOperationTimeoutMs > candidate.maxDurationMs) {
        throw new AgentRuntimeError('per-operation timeout cannot exceed total duration')
    }
    return candidate
}

const isModelDecision = (value: ModelDecision): value is ModelDecision => {
    if (!value || typeof value !== 'object') return false
    if (value.kind === 'final') {
        return typeof value.output === 'string'
    }
    return (
        value.kind === 'tool_call' &&
        typeof value.callId === 'string' &&
        value.callId.length > 0 &&
        value.callId.length <= 128 &&
        typeof value.name === 'string'
    )
}

const event = (
    type: RunEvent['type'],
    at: number,
    options: {
        step?: number
        toolName?: string
        status?: RunStatus
        detail?: Readonly<Record<string, JsonValue>>
    } = {}
): RunEvent => ({ type, at, ...options })

const result = (snapshot: RunSnapshot): AgentRunResult => ({
    runId: snapshot.id,
    status: snapshot.status,
    output: snapshot.output,
    steps: snapshot.stepCount,
    toolCalls: snapshot.toolCallCount,
})

const isCancellation = (
    error: unknown,
    externalSignal: AbortSignal | undefined,
    internalSignal: AbortSignal
): boolean =>
    error instanceof RunCancelledError ||
    (internalSignal.aborted && !(error instanceof OperationTimeoutError)) ||
    Boolean(externalSignal?.aborted)
