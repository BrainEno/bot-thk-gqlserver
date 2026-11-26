import { randomUUID } from 'crypto'
import {
    AgentBudget,
    AgentPolicy,
    AgentResumeInput,
    AgentRunCheckpoint,
    AgentRunInput,
    AgentRunResult,
    ApprovalGrant,
    ApprovalRequestRecord,
    ApprovalWorkflow,
    CheckpointCipher,
    JsonValue,
    ModelDecision,
    AgentMessage,
    ModelProvider,
    PendingApproval,
    PolicyDecision,
    RunEvent,
    RunSnapshot,
    RunStatus,
    RunStore,
    TraceSink,
} from './types'
import { canonicalJson, digestJson } from './canonicalJson'
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

const DEFAULT_APPROVAL_TTL_MS = 15 * 60 * 1000
const MAX_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000

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

interface ManagedController extends AbortController {
    readonly cancel: () => void
}

interface LoopState {
    readonly input: AgentRunInput
    readonly budget: AgentBudget
    readonly deadline: number
    readonly controller: ManagedController
    snapshot: RunSnapshot
    readonly messages: AgentMessage[]
    steps: number
    toolCalls: number
}

interface PreapprovedAction {
    readonly decision: Extract<ModelDecision, { kind: 'tool_call' }>
    readonly input: JsonValue
}

interface ToolStepResult {
    readonly snapshot: RunSnapshot
    readonly terminal?: AgentRunResult
}

export class AgentRuntime {
    constructor(
        private readonly provider: ModelProvider,
        private readonly registry: ToolRegistry,
        private readonly policy: AgentPolicy,
        private readonly store: RunStore,
        private readonly trace: TraceSink = new NoopTraceSink(),
        private readonly clock: () => number = Date.now,
        private readonly checkpointCipher?: CheckpointCipher,
        private readonly approvals?: ApprovalWorkflow,
        private readonly approvalTtlMs = DEFAULT_APPROVAL_TTL_MS
    ) {
        this.registry.seal()
        if (!Number.isInteger(approvalTtlMs) || approvalTtlMs < 1_000 || approvalTtlMs > MAX_APPROVAL_TTL_MS) {
            throw new AgentRuntimeError('approval TTL must be between one second and 24 hours')
        }
    }

    async run(input: AgentRunInput): Promise<AgentRunResult> {
        assertRunInput(input)
        const budget = normalizeBudget(input.budget)
        const createdAt = this.clock()
        const snapshot: RunSnapshot = {
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

        const controller = createController(input.signal)
        const state: LoopState = {
            input,
            budget,
            deadline: createdAt + budget.maxDurationMs,
            controller,
            snapshot,
            messages: [{ role: 'user', content: input.task }],
            steps: 0,
            toolCalls: 0,
        }

        try {
            state.snapshot = await this.record(state.snapshot, event('run_created', this.clock()))
            state.snapshot = await this.store.transition(input.runId, 'running', {}, state.snapshot.version)
            state.snapshot = await this.record(
                state.snapshot,
                event('run_started', this.clock(), { status: 'running' })
            )
            return await this.executeLoop(state)
        } catch (error) {
            return this.handleFatal(state, error)
        } finally {
            input.signal?.removeEventListener('abort', controller.cancel)
        }
    }

    /** Resume only an encrypted, exact-action checkpoint after its approver has approved. */
    async resume(input: AgentResumeInput): Promise<AgentRunResult> {
        assertResumeInput(input)
        if (!this.checkpointCipher || !this.approvals) {
            throw new AgentRuntimeError('approval resume services are not configured')
        }
        const snapshot = await this.store.get(input.runId, {
            tenantId: input.principal.tenantId,
            principalId: input.principal.id,
        })
        if (
            !snapshot ||
            snapshot.status !== 'waiting_for_approval' ||
            !snapshot.checkpoint ||
            !snapshot.pendingApproval ||
            snapshot.pendingApproval.id !== input.approvalId
        ) {
            throw new AgentRuntimeError('run is not available for approval resume')
        }

        const checkpoint = this.checkpointCipher.open(input.runId, snapshot.checkpoint)
        assertCheckpointMatchesRun(checkpoint, snapshot, this.clock())
        const approval = await this.approvals.get(input.approvalId, input.principal.tenantId)
        if (!approval || !isApprovedGrant(approval, checkpoint, input.principal, input.runId, input.approvalId, this.clock())) {
            throw new AgentRuntimeError('approval is not approved for this pending action')
        }

        const tool = this.registry.get(checkpoint.pendingAction.toolName)
        if (!tool || validateJsonSchema(checkpoint.pendingAction.input, tool.inputSchema).length > 0) {
            throw new AgentRuntimeError('pending tool action is no longer valid')
        }
        const controller = createController(input.signal)
        const resumeDeadline = this.clock() + checkpoint.remainingDurationMs
        let policyDecision: PolicyDecision
        try {
            policyDecision = await this.perform(
                () => this.policy.authorize({
                    runId: input.runId,
                    principal: input.principal,
                    tool,
                    args: checkpoint.pendingAction.input,
                    approval: approvalGrant(approval),
                    now: this.clock(),
                }),
                controller,
                resumeDeadline,
                normalizeBudget(checkpoint.budget).perOperationTimeoutMs
            )
        } catch (error) {
            input.signal?.removeEventListener('abort', controller.cancel)
            throw error
        }
        if (policyDecision.kind !== 'allow') {
            input.signal?.removeEventListener('abort', controller.cancel)
            throw new AgentRuntimeError('approval could not be consumed')
        }

        const resumeInput: AgentRunInput = {
            runId: input.runId,
            task: checkpoint.task,
            principal: input.principal,
            budget: checkpoint.budget,
            signal: input.signal,
        }
        const state: LoopState = {
            input: resumeInput,
            budget: normalizeBudget(checkpoint.budget),
            deadline: resumeDeadline,
            controller,
            snapshot,
            messages: checkpoint.messages.map((message) => ({ ...message })),
            steps: checkpoint.stepCount,
            toolCalls: checkpoint.toolCallCount,
        }

        try {
            // Claim the waiting run with its current version and erase the encrypted copy before effects.
            state.snapshot = await this.store.transition(
                input.runId,
                'running',
                {
                    stepCount: state.steps,
                    toolCallCount: state.toolCalls,
                    checkpoint: null,
                    pendingApproval: null,
                },
                state.snapshot.version
            )
            state.snapshot = await this.record(
                state.snapshot,
                event('run_resumed', this.clock(), { status: 'running' })
            )
            state.snapshot = await this.record(
                state.snapshot,
                event('approval_resumed', this.clock(), {
                    step: state.steps,
                    toolName: tool.name,
                    detail: { approvalId: input.approvalId },
                })
            )
            const decision: Extract<ModelDecision, { kind: 'tool_call' }> = {
                kind: 'tool_call',
                callId: checkpoint.pendingAction.callId,
                name: checkpoint.pendingAction.toolName,
                input: checkpoint.pendingAction.input,
            }
            return await this.executeLoop(state, {
                decision,
                input: checkpoint.pendingAction.input,
            })
        } catch (error) {
            return this.handleFatal(state, error)
        } finally {
            input.signal?.removeEventListener('abort', controller.cancel)
        }
    }

    private async executeLoop(state: LoopState, firstAction?: PreapprovedAction): Promise<AgentRunResult> {
        try {
            while (firstAction || state.steps < state.budget.maxSteps) {
                this.ensureRunning(state.controller.signal, state.deadline)
                let decision: ModelDecision
                const isResumedAction = Boolean(firstAction)
                if (firstAction) {
                    decision = firstAction.decision
                    firstAction = undefined
                } else {
                    state.steps += 1
                    state.snapshot = await this.record(
                        state.snapshot,
                        event('model_step_started', this.clock(), { step: state.steps })
                    )
                    decision = await this.perform(
                        (signal) => this.provider.nextAction({
                            runId: state.input.runId,
                            messages: state.messages,
                            tools: this.registry.descriptions(),
                            signal,
                        }),
                        state.controller,
                        state.deadline,
                        state.budget.perOperationTimeoutMs
                    )
                }

                if (!isModelDecision(decision)) {
                    return await this.fail(state, 'invalid model response')
                }
                if (decision.kind === 'final') {
                    if (decision.output.length > state.budget.maxOutputChars) {
                        return await this.fail(state, 'output budget exceeded')
                    }
                    state.snapshot = await this.record(
                        state.snapshot,
                        event('run_succeeded', this.clock(), { status: 'succeeded' })
                    )
                    state.snapshot = await this.store.transition(
                        state.input.runId,
                        'succeeded',
                        {
                            output: decision.output,
                            stepCount: state.steps,
                            toolCallCount: state.toolCalls,
                            checkpoint: null,
                            pendingApproval: null,
                        },
                        state.snapshot.version
                    )
                    return result(state.snapshot)
                }

                const outcome = await this.executeToolCall(state, decision, isResumedAction)
                state.snapshot = outcome.snapshot
                if (outcome.terminal) return outcome.terminal
            }
            return await this.fail(state, 'step budget exceeded')
        } catch (error) {
            return this.handleFatal(state, error)
        }
    }

    private async executeToolCall(
        state: LoopState,
        decision: Extract<ModelDecision, { kind: 'tool_call' }>,
        isPrecounted: boolean
    ): Promise<ToolStepResult> {
        if (!isPrecounted) {
            if (state.toolCalls >= state.budget.maxToolCalls) {
                const terminal = await this.fail(state, 'tool call budget exceeded')
                return { snapshot: state.snapshot, terminal }
            }
            state.toolCalls += 1
            state.snapshot = await this.record(
                state.snapshot,
                event('tool_call_requested', this.clock(), {
                    step: state.steps,
                    toolName: decision.name,
                })
            )
        }

        const tool = this.registry.get(decision.name)
        if (!tool) {
            const terminal = await this.fail(state, 'unregistered tool requested')
            return { snapshot: state.snapshot, terminal }
        }
        const issues = validateJsonSchema(decision.input, tool.inputSchema)
        if (issues.length > 0 || !isJsonValue(decision.input)) {
            const terminal = await this.fail(state, 'tool input rejected')
            return { snapshot: state.snapshot, terminal }
        }
        const args = decision.input as JsonValue
        const policyDecision = isPrecounted
            ? { kind: 'allow' as const }
            : await this.perform(
                () => this.policy.authorize({
                    runId: state.input.runId,
                    principal: state.input.principal,
                    tool,
                    args,
                    approval: state.input.approval,
                    now: this.clock(),
                }),
                state.controller,
                state.deadline,
                state.budget.perOperationTimeoutMs
            )

        if (policyDecision.kind === 'deny') {
            state.snapshot = await this.record(
                state.snapshot,
                event('tool_call_denied', this.clock(), {
                    toolName: tool.name,
                    detail: { reason: policyDecision.reason },
                })
            )
            const terminal = await this.fail(state, 'tool call denied by policy')
            return { snapshot: state.snapshot, terminal }
        }
        if (policyDecision.kind === 'approval_required') {
            const suspended = await this.suspendForApproval(state, decision, tool.name, args, policyDecision.inputDigest)
            return { snapshot: state.snapshot, terminal: suspended }
        }

        state.snapshot = await this.record(
            state.snapshot,
            event('tool_call_started', this.clock(), { step: state.steps, toolName: tool.name })
        )
        let output: JsonValue
        try {
            output = await this.perform(
                (signal) => tool.execute(args, {
                    runId: state.input.runId,
                    principal: state.input.principal,
                    signal,
                }),
                state.controller,
                state.deadline,
                state.budget.perOperationTimeoutMs
            )
        } catch (error) {
            if (isCancellation(error, state.input.signal, state.controller.signal)) throw error
            state.snapshot = await this.record(
                state.snapshot,
                event('tool_call_failed', this.clock(), {
                    toolName: tool.name,
                    detail: { reason: 'tool execution failed' },
                })
            )
            state.messages.push({
                role: 'tool',
                toolCallId: decision.callId,
                content: 'Tool failed. Do not assume it succeeded.',
            })
            return { snapshot: state.snapshot }
        }

        if (!isJsonValue(output)) {
            const terminal = await this.fail(state, 'tool returned non-JSON output')
            return { snapshot: state.snapshot, terminal }
        }
        const serializedOutput = canonicalJson(output)
        if (serializedOutput.length > state.budget.maxOutputChars) {
            const terminal = await this.fail(state, 'tool output budget exceeded')
            return { snapshot: state.snapshot, terminal }
        }
        state.snapshot = await this.record(
            state.snapshot,
            event('tool_call_succeeded', this.clock(), { toolName: tool.name })
        )
        state.messages.push({ role: 'assistant', content: `Requested tool ${tool.name}.` })
        state.messages.push({ role: 'tool', toolCallId: decision.callId, content: serializedOutput })
        return { snapshot: state.snapshot }
    }

    private async suspendForApproval(
        state: LoopState,
        decision: Extract<ModelDecision, { kind: 'tool_call' }>,
        toolName: string,
        args: JsonValue,
        inputDigest: string
    ): Promise<AgentRunResult> {
        if (!this.checkpointCipher || !this.approvals) {
            return this.fail(state, 'approval workflow is not configured')
        }
        const now = this.clock()
        const expiresAt = now + this.approvalTtlMs
        const remainingDurationMs = Math.floor(state.deadline - now)
        if (remainingDurationMs <= 0) return this.fail(state, 'run timed out before approval suspension')

        const grant: ApprovalGrant = {
            id: randomUUID(),
            runId: state.input.runId,
            principalId: state.input.principal.id,
            tenantId: state.input.principal.tenantId,
            toolName,
            inputDigest,
            expiresAt,
        }
        const checkpoint: AgentRunCheckpoint = {
            schemaVersion: 1,
            task: state.input.task,
            messages: state.messages.map((message) => ({ ...message })),
            budget: state.budget,
            stepCount: state.steps,
            toolCallCount: state.toolCalls,
            pendingAction: {
                callId: decision.callId,
                toolName,
                input: args,
                inputDigest,
            },
            createdAt: now,
            expiresAt,
            remainingDurationMs,
        }
        const sealed = this.checkpointCipher.seal(state.input.runId, checkpoint)
        const pendingApproval: PendingApproval = { id: grant.id, toolName, inputDigest, expiresAt }
        state.snapshot = await this.record(
            state.snapshot,
            event('approval_required', this.clock(), {
                toolName,
                detail: { approvalId: grant.id, inputDigest },
            })
        )
        try {
            // Persist the human decision record before exposing a resumable run state.
            await this.approvals.createPending(grant, state.input.principal.id, now)
        } catch {
            return this.fail(state, 'approval request could not be persisted')
        }
        state.snapshot = await this.store.transition(
            state.input.runId,
            'waiting_for_approval',
            {
                stepCount: state.steps,
                toolCallCount: state.toolCalls,
                checkpoint: sealed,
                pendingApproval,
            },
            state.snapshot.version
        )
        return result(state.snapshot)
    }

    private async fail(state: LoopState, reason: string): Promise<AgentRunResult> {
        if (state.snapshot.status !== 'running') return result(state.snapshot)
        state.snapshot = await this.record(
            state.snapshot,
            event('run_failed', this.clock(), { status: 'failed', detail: { reason } })
        )
        state.snapshot = await this.store.transition(
            state.input.runId,
            'failed',
            {
                stepCount: state.steps,
                toolCallCount: Math.min(state.toolCalls, state.steps),
                checkpoint: null,
                pendingApproval: null,
            },
            state.snapshot.version
        )
        return result(state.snapshot)
    }

    private async handleFatal(state: LoopState, error: unknown): Promise<AgentRunResult> {
        if (isCancellation(error, state.input.signal, state.controller.signal)) {
            return this.cancel(state)
        }
        if (error instanceof OperationTimeoutError) return this.fail(state, 'run timed out')
        return this.fail(state, 'agent execution failed')
    }

    private async cancel(state: LoopState): Promise<AgentRunResult> {
        if (state.snapshot.status !== 'running') return result(state.snapshot)
        state.snapshot = await this.record(
            state.snapshot,
            event('run_cancelled', this.clock(), { status: 'cancelled' })
        )
        state.snapshot = await this.store.transition(
            state.input.runId,
            'cancelled',
            {
                stepCount: state.steps,
                toolCallCount: Math.min(state.toolCalls, state.steps),
                checkpoint: null,
                pendingApproval: null,
            },
            state.snapshot.version
        )
        return result(state.snapshot)
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
            await this.trace.emit(runEvent, { runId: snapshot.id, tenantId: snapshot.tenantId })
        } catch {
            // Optional telemetry must not change execution authorization or tool effects.
        }
        return updated
    }
}

const assertRunInput = (input: AgentRunInput): void => {
    if (!input || !/^[A-Za-z0-9_-]{8,96}$/.test(input.runId)) {
        throw new AgentRuntimeError('run id must be a non-secret opaque identifier')
    }
    if (typeof input.task !== 'string' || !input.task.trim() || input.task.length > 16_000) {
        throw new AgentRuntimeError('task length must be 1 to 16000 characters')
    }
    if (!isPrincipal(input.principal)) throw new AgentRuntimeError('principal identity is invalid')
}

const assertResumeInput = (input: AgentResumeInput): void => {
    if (
        !input ||
        !/^[A-Za-z0-9_-]{8,96}$/.test(input.runId) ||
        typeof input.approvalId !== 'string' ||
        !/^[A-Za-z0-9_-]{22,128}$/.test(input.approvalId) ||
        !isPrincipal(input.principal)
    ) {
        throw new AgentRuntimeError('approval resume request is invalid')
    }
}

const isPrincipal = (principal: AgentRunInput['principal']): boolean =>
    Boolean(
        principal &&
            typeof principal.id === 'string' &&
            principal.id.trim().length > 0 &&
            principal.id.length <= 128 &&
            typeof principal.tenantId === 'string' &&
            principal.tenantId.trim().length > 0 &&
            principal.tenantId.length <= 128 &&
            Array.isArray(principal.permissions)
    )

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

const assertCheckpointMatchesRun = (
    checkpoint: AgentRunCheckpoint,
    snapshot: RunSnapshot,
    now: number
): void => {
    if (
        checkpoint.expiresAt <= now ||
        checkpoint.stepCount !== snapshot.stepCount ||
        checkpoint.toolCallCount !== snapshot.toolCallCount ||
        checkpoint.pendingAction.toolName !== snapshot.pendingApproval?.toolName ||
        checkpoint.pendingAction.inputDigest !== snapshot.pendingApproval?.inputDigest ||
        checkpoint.expiresAt !== snapshot.pendingApproval?.expiresAt ||
        digestJson(checkpoint.pendingAction.input) !== checkpoint.pendingAction.inputDigest
    ) {
        throw new AgentRuntimeError('approval checkpoint is expired or inconsistent')
    }
}

const isApprovedGrant = (
    record: Awaited<ReturnType<ApprovalWorkflow['get']>>,
    checkpoint: AgentRunCheckpoint,
    principal: AgentRunInput['principal'],
    runId: string,
    approvalId: string,
    now: number
): record is ApprovalRequestRecord =>
    Boolean(
        record &&
            record.state === 'approved' &&
            record.id === approvalId &&
            record.runId === runId &&
            record.principalId === principal.id &&
            record.tenantId === principal.tenantId &&
            record.requestedBy === principal.id &&
            Number.isFinite(record.requestedAt) &&
            record.requestedAt <= now &&
            record.requestedAt <= record.expiresAt &&
            typeof record.decidedBy === 'string' &&
            record.decidedBy.length > 0 &&
            record.decidedBy !== principal.id &&
            typeof record.decidedAt === 'number' &&
            Number.isFinite(record.decidedAt) &&
            record.decidedAt <= now &&
            record.decidedAt >= record.requestedAt &&
            record.decidedAt < record.expiresAt &&
            record.expiresAt > now &&
            record.toolName === checkpoint.pendingAction.toolName &&
            record.inputDigest === checkpoint.pendingAction.inputDigest &&
            record.expiresAt === checkpoint.expiresAt
    )

const approvalGrant = (record: NonNullable<Awaited<ReturnType<ApprovalWorkflow['get']>>>): ApprovalGrant => ({
    id: record.id,
    runId: record.runId,
    principalId: record.principalId,
    tenantId: record.tenantId,
    toolName: record.toolName,
    inputDigest: record.inputDigest,
    expiresAt: record.expiresAt,
})

const isModelDecision = (value: ModelDecision): value is ModelDecision => {
    if (!value || typeof value !== 'object') return false
    if (value.kind === 'final') return typeof value.output === 'string'
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
    pendingApproval: snapshot.pendingApproval,
})

const createController = (externalSignal?: AbortSignal): ManagedController => {
    const controller = new AbortController() as ManagedController
    const cancel = () => controller.abort()
    Object.defineProperty(controller, 'cancel', { value: cancel })
    externalSignal?.addEventListener('abort', cancel, { once: true })
    if (externalSignal?.aborted) controller.abort()
    return controller
}

const isCancellation = (
    error: unknown,
    externalSignal: AbortSignal | undefined,
    internalSignal: AbortSignal
): boolean =>
    error instanceof RunCancelledError ||
    (internalSignal.aborted && !(error instanceof OperationTimeoutError)) ||
    Boolean(externalSignal?.aborted)
